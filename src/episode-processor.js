import {execFile} from 'node:child_process';
import {access, mkdir} from 'node:fs/promises';
import {constants as fsConstants, createReadStream} from 'node:fs';
import {EOL} from 'node:os';
import {basename, join} from 'node:path';

import {GetObjectCommand, ListBucketsCommand, ListObjectsV2Command, S3Client} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {red} from 'colorette';
import got from 'got';
import {Manager, figures} from 'listr2';

import {FFMpegQueue, getOutputEncodingSettings, getPartEncodingSettings, runFFmpeg} from './ffmpeg.js';
import {delay, formatDuration, getFileName, getPartInfo, joinS3Path, parseDuration} from './utils.js';
import {getUploadOptions, updateTaskWithUpload} from './s3.js';

export default class EpisodeProcessor {
	constructor(argv) {
		this.argv = argv;

		this.source = argv.source;
		this.outputBase = argv.outputBase;

		this.parts = argv.parts;
		this.formats = argv.formats;

		this.s3 = this.configureS3();
		// https://github.com/aws/aws-sdk-js-v3/issues/2438
		this.signS3 = this.configureS3();

		this.buckets = argv.upload ? {
			private: {
				...argv.upload.private,
				outputPrefix: joinS3Path(argv.upload.private.prefix, this.outputBase),
			},
			public: {
				...argv.upload.public,
				outputPrefix: joinS3Path(argv.upload.public.prefix, this.outputBase),
			},
		} : false;

		this.ffmpegQueues = {
			video: new FFMpegQueue(argv.parallel?.video ?? 1),
		};
		this.ffmpegQueues.audio = argv.parallel?.audio > 0 ? new FFMpegQueue(argv.parallel.audio) : this.ffmpegQueues.video;
		this.hwEnc = argv.hwEnc;

		this.webhookErrors = [];

		this.tasks = new Manager({
			rendererOptions: {
				collapse: false,
				collapseSkips: false,
				removeEmptyLines: false,
				showTimer: true,
			},
		});
		this.populateTasks();
	}

	configureS3() {
		const client = new S3Client({
			// DO Spaces don't need this while S3 client fails without it
			region: '-',
			...this.argv.upload.options,
		});

		// https://github.com/aws/aws-sdk-js-v3/issues/1814#issuecomment-765624523
		client.middlewareStack.add(
			(next, _context) => args => {
				if (
					args.request
					&& args.request.body
					&& args.request.body.includes('CompletedMultipartUpload')
				) {
					args.request.body = args.request.body.replace(
						/CompletedMultipartUpload/g,
						'CompleteMultipartUpload',
					);
				}

				return next(args);
			},
			{
				step: 'build',
				priority: 'high',
			},
		);

		return client;
	}

	async run() {
		await this.tasks.runAll();

		if (this.webhookErrors.length > 0) {
			console.error(`Webhook had ${this.webhookErrors.length} errors, showing first 5`);
			console.error(this.webhookErrors.slice(0, 5));
		}
	}

	populateTasks() {
		this.tasks.add([
			this.tasks.indent(
				this.checklist(),
				{},
				{
					title: 'Pre-run Checklist',
				},
			),
			this.tasks.indent(
				[
					{
						title: 'Notifying discord of start',
						task: async context => {
							await this.postWebHook(
								':star: Started processing',
								context.summary,
							);
						},
					},
					{
						title: 'Create local folders',
						task: async context => {
							context.uploads = {
								raw: {
									filename: undefined,
									location: undefined,
								},
								parts: context.parts.map(part => ({
									part,
									location: undefined,
									outputs: this.formats.map(format => ({
										name: getFileName(part.filename, format),
										location: undefined,
									})),
								})),
							};

							await mkdir(this.outputBase);
							await mkdir(join(this.outputBase, 'parts'));
						},
					},
					this.indentWithDiscordStatus(
						context => this.getCuts(context),
						{
							concurrent: true,
						},
						{
							title: 'Generate Cuts',
						},
					),
					this.indentWithDiscordStatus(
						context => this.getPublishedFiles(context),
						{
							concurrent: true,
						},
						{
							title: 'Generate published files',
						},
					),
				],
				{},
				{
					rollback: async () => {
						// Webhook for error
						await this.postWebHook(
							':x: Processing error, manual intervention required.',
							undefined,
							true,
						);
					},
				},
			),
			{
				title: 'Post result to discord',
				task: context => this.resultToWebhook(context),
			},
		]);
	}

	checklist() {
		return [
			{
				title: 'Environment: ffmpeg installed',
				task: async (_context, task) => {
					await new Promise((resolve, reject) => {
						execFile('ffmpeg', ['-version'], (error, stdout) => {
							if (error) {
								return reject(error);
							}

							task.output = stdout;
							resolve();
						});
					});
				},
				options: {
					persistentOutput: true,
				},
			},
			{
				title: 'Environment: ffprobe installed',
				task: async (_context, task) => {
					await new Promise((resolve, reject) => {
						execFile('ffprobe', ['-version'], (error, stdout) => {
							if (error) {
								return reject(error);
							}

							task.output = stdout;
							resolve();
						});
					});
				},
			},
			{
				title: 'Input file exists',
				task: async () => {
					await access(this.source, fsConstants.R_OK);
				},
			},
			{
				title: 'Output folder doesn\'t exist',
				task: async () => {
					try {
						await access(this.outputBase, fsConstants.F_OK);
					} catch (error) {
						if (error.code === 'ENOENT') {
							return;
						}

						throw error;
					}

					throw new Error(`Folder ${this.outputBase} already exists locally`);
				},
			},
			{
				title: 'Check S3 access',
				enabled: () => this.buckets,
				task: async () => {
					const request = new ListBucketsCommand({});
					const {Buckets: buckets} = await this.s3.send(request);

					const privateB = buckets.find(({Name}) => Name === this.buckets.private.bucket);
					if (!privateB) {
						throw new Error('Private bucket not found');
					}

					const publicB = buckets.find(({Name}) => Name === this.buckets.public.bucket);
					if (!publicB) {
						throw new Error('Public bucket not found');
					}
				},
			},
			{
				title: 'S3: no files in private',
				enabled: () => this.buckets,
				task: async () => {
					const request = new ListObjectsV2Command({
						Bucket: this.buckets.private.bucket,
						Prefix: this.buckets.private.outputPrefix,
					});
					const {KeyCount, Contents} = await this.s3.send(request);

					if (KeyCount > 0) {
						throw new Error(
							`Private bucket already has ${KeyCount} files starting with ${this.buckets.private.outputPrefix}\n\n`
							+ Contents.slice(0, 10).map(({Key}) => Key).join(', '),
						);
					}
				},
			},
			{
				title: 'S3: no files in public',
				enabled: () => this.buckets,
				task: async () => {
					const request = new ListObjectsV2Command({
						Bucket: this.buckets.public.bucket,
						Prefix: this.buckets.public.outputPrefix,
					});
					const {KeyCount, Contents} = await this.s3.send(request);

					if (KeyCount > 0) {
						throw new Error(
							`Public bucket already has ${KeyCount} files starting with ${this.buckets.private.outputPrefix}\n\n`
							+ Contents.slice(0, 10).map(({Key}) => Key).join(', '),
						);
					}
				},
			},
			{
				title: 'Input: ffprobe analyse',
				task: async (context, task) => {
					await new Promise((resolve, reject) => {
						execFile('ffprobe', ['-hide_banner', '-print_format', 'json', '-show_format', this.source], (error, stdout, stderr) => {
							if (error) {
								return reject(new Error(`Couldn't execute ${error.path}: ${error.code}`));
							}

							context.ffprobe = JSON.parse(stdout);

							task.output = stderr;
							resolve();
						});
					});
				},
				options: {
					persistentOutput: true,
				},
			},
			{
				title: 'Plan',
				task: async (context, task) => {
					const duration = Number.parseFloat(context.ffprobe.format.duration);

					const start = this.argv.start ? parseDuration(this.argv.start) : 0;
					const cuts = this.argv.cuts.map(v => (/^\d/.test(v) ? parseDuration(v) : v));
					const end = this.argv.end ? parseDuration(this.argv.end) : duration;

					const parts = [];
					let partStart = start;
					let partI = 0;
					let skipNext = false;
					for (const cut of cuts) {
						if (cut === 'skip') {
							skipNext = true;
							continue;
						}

						if (skipNext) {
							skipNext = false;
							partStart = cut;
							continue;
						}

						const index = partI++;
						if (this.parts[index] === false) {
							partStart = cut;
							continue;
						}

						parts.push(getPartInfo({
							start: partStart,
							end: cut,
							index,
							partOptions: this.parts[index],
							outputBase: this.outputBase,
						}));
						partStart = cut;
					}

					if (this.parts[partI] !== false) {
						parts.push(getPartInfo({
							start: partStart,
							end,
							index: partI,
							partOptions: this.parts[partI],
							outputBase: this.outputBase,
						}));
					}

					context.start = start;
					context.end = end;
					context.parts = parts;

					context.summary = [
						`Input file: ${this.source} (${formatDuration(duration)})`,
						`Output folder (local): ${this.outputBase}/`,
						...(this.buckets ? [
							`Output prefix (private): ${this.buckets.private.outputPrefix}/`,
							`Output prefix (public): ${this.buckets.public.outputPrefix}/`,
						] : [
							red('No upload'),
						]),
						'',
						...parts.map((part, index) => `Part ${index + 1}: ${formatDuration(part.start)} - ${formatDuration(part.end)} (duration: ${formatDuration(part.end - part.start)})  ${part.filename}`),
					].join(EOL);
					task.output = context.summary;

					for (const part of parts) {
						if (part.end < part.start) {
							throw new Error(`Negative duration: ${formatDuration(part.start)} - ${formatDuration(part.end)}`);
						}
					}

					const lastPart = parts[parts.length - 1];
					if (lastPart.end > duration) {
						throw new Error('Last part end is after source end.');
					}
				},
				options: {
					persistentOutput: true,
				},
			},
			{
				title: 'User confirmation',
				task: async (context, task) => {
					const answer = this.argv.force || await task.prompt({
						type: 'confirm',
						message: context.summary + EOL + 'Confirm this looks good',
					});
					if (!answer) {
						throw new Error('Cancelled by user');
					}
				},
			},
		];
	}

	getCuts(context) {
		const tasks = [];

		tasks.push({
			title: 'Upload source',
			enabled: () => this.buckets && this.argv.upload?.uploadRaw !== false,
			task: async (context, task) => {
				const sourceFileName = basename(this.source);
				task.title = task.title + ' ' + sourceFileName;

				const params = {
					Bucket: this.buckets.private.bucket,
					Key: joinS3Path(this.buckets.private.outputPrefix, 'source', sourceFileName),
					Body: createReadStream(this.source),
				};

				const upload = new Upload({
					client: this.s3,
					...getUploadOptions(params, this.outputBase),
				});

				updateTaskWithUpload(task, upload);

				const {Bucket, Key, Location} = await upload.done();
				task.output = Location;

				const url = await getSignedUrl(this.signS3, new GetObjectCommand({
					Bucket,
					Key,
				}), {expiresIn: 7 * 24 * 60 * 60});
				context.uploads.raw.filename = sourceFileName;
				context.uploads.raw.location = url;
			},
		});

		for (const part of context.parts) {
			const localLocation = join(this.outputBase, 'parts', part.filename + '.mp4');

			tasks.push(this.tasks.indent([
				{
					title: 'Wait for encoder slot',
					task: async () => {
						await this.ffmpegQueues.video.wait();
					},
				},
				{
					title: 'Encode cut',
					task: async (_context, task) => {
						const args = getPartEncodingSettings(
							part,
							this.source,
							localLocation,
							this.argv.partEncoding,
							this.hwEnc,
						);
						try {
							await runFFmpeg(args, task);
						} finally {
							this.ffmpegQueues.video.done();
						}
					},
				},
				{
					title: 'Upload',
					enabled: () => this.buckets,
					task: async (context, task) => {
						const params = {
							Bucket: this.buckets.private.bucket,
							Key: joinS3Path(this.buckets.private.outputPrefix, part.filename + '.mp4'),
							Body: createReadStream(localLocation),
						};

						const upload = new Upload({
							client: this.s3,
							...getUploadOptions(params, this.outputBase),
						});

						updateTaskWithUpload(task, upload);

						const {Bucket, Key, Location} = await upload.done();
						task.output = Location;

						const url = await getSignedUrl(this.signS3, new GetObjectCommand({
							Bucket,
							Key,
						}), {expiresIn: 7 * 24 * 60 * 60});
						context.uploads.parts[part.index].location = url;
					},
				},
			], {}, {
				title: part.filename,
			}));
		}

		return tasks;
	}

	getPublishedFiles(context) {
		const tasks = [];

		for (const part of context.parts) {
			const partLocation = join(this.outputBase, 'parts', part.filename + '.mp4');

			for (const [index, format] of this.formats.entries()) {
				const filename = getFileName(part.filename, format);
				const outputLocation = join(this.outputBase, filename);
				const ffmpegQueue = this.ffmpegQueues[format?.type ?? 'video'];

				tasks.push(this.tasks.indent([
					{
						title: 'Wait for encoder slot',
						task: async () => {
							await ffmpegQueue.wait();
						},
					},
					{
						title: 'Encode cut',
						task: async (_context, task) => {
							const args = getOutputEncodingSettings(format, partLocation, outputLocation, this.hwEnc);
							try {
								await runFFmpeg(args, task);
							} finally {
								ffmpegQueue.done();
							}
						},
					},
					{
						title: 'Upload',
						enabled: () => this.buckets,
						task: async (context, task) => {
							const params = {
								Bucket: this.buckets.public.bucket,
								Key: joinS3Path(this.buckets.public.outputPrefix, filename),
								Body: createReadStream(outputLocation),
							};

							const upload = new Upload({
								client: this.s3,
								...getUploadOptions(params, this.outputBase, true),
							});

							updateTaskWithUpload(task, upload);

							const {Location} = await upload.done();
							task.output = Location;
							context.uploads.parts[part.index].outputs[index].location = Location;
						},
					},
				], {}, {
					title: filename,
				}));
			}
		}

		return tasks;
	}

	async resultToWebhook(context) {
		if (!this.buckets) {
			await this.postWebHook({
				content: `:tada: Finished processing ${this.outputBase}

This run was local only.`,
			});
			return;
		}

		await this.postWebHook({
			content: `:tada: Finished processing ${this.outputBase}

Listing private files: (Signed url accessible for 7 days)`,
			embeds: [
				{
					title: `Source file (${context.uploads.raw.filename})`,
					url: context.uploads.raw.location,
				},
			],
		});
		await delay(500);

		// Parts
		{
			const embeds = context.uploads.parts.slice(0, 10).map(part => ({
				title: part.part.filename,
				url: part.location,
			}));

			await this.postWebHook({
				embeds,
			});
		}

		await delay(500);

		// Outputs
		{
			const embeds = context.uploads.parts.slice(0, 10).map(part => ({
				title: part.part.filename,
				fields: part.outputs.slice(0, 25).map(output => ({
					name: output.name,
					value: output.location,
				})),
			}));

			await this.postWebHook({
				content: 'Publically available files:',
				embeds,
			});
		}

		await delay(500);

		await this.postWebHook(
			':white_check_mark: Listing complete',
			undefined,
			true,
		);
	}

	indentWithDiscordStatus(tasks, options, taskOptions) {
		return {
			...taskOptions,
			task: (context, task) => {
				// Generate discord updates
				const innerTask = task.task;
				let chain = Promise.resolve((...args) => this.postWebHook(...args));

				const postStatusUpdate = () => {
					chain = chain.then(async post => {
						if (post) {
							const status = [];

							const logSubtasks = (task, depth = 0) => {
								if (!task.isEnabled()) {
									return;
								}

								let icon = ' ';

								switch (true) {
									case task.isPending():
										icon = figures.pointer;
										break;
									case task.isCompleted():
										icon = figures.tick;
										break;
									case task.hasFailed():
										icon = figures.cross;
										break;
									default:
										icon = ' ';
								}

								status.push(('  ').repeat(depth) + icon + ' ' + task.title);
								if (task.output && !task.isCompleted()) {
									status.push(('  ').repeat(depth + 1) + task.output.slice(0, 100));
								}

								if (task.hasSubtasks() && (!task.isCompleted() || depth === 0)) {
									for (const childTask of task.subtasks) {
										logSubtasks(childTask, depth + 1);
									}
								}
							};

							logSubtasks(innerTask);

							let icon = ':yellow_circle:';
							if (innerTask.isCompleted()) {
								icon = ':green_circle:';
							} else if (innerTask.hasFailed()) {
								icon = ':red_circle:';
							}

							return post(
								`${icon} ${innerTask.title}`,
								status.join('\n').slice(0, 1900),
							);
						}
					});
				};

				const interval = setInterval(() => {
					postStatusUpdate();
				}, 15 * 1000);
				innerTask.subscribe(() => {
					if (!innerTask.isPending()) {
						clearInterval(interval);
						postStatusUpdate();
					}
				});
				setTimeout(postStatusUpdate, 1);

				return task.newListr(typeof tasks === 'function' ? tasks(context) : tasks, options);
			},
		};
	}

	// eslint-disable-next-line unicorn/no-useless-undefined
	async postWebHook(message, log, ping = false, messageId = undefined) {
		if (!this.argv.discord.webhook) {
			return;
		}

		let json = message;
		if (typeof message === 'string') {
			let content = message;
			if (log) {
				// eslint-disable-next-line no-control-regex
				content += '\n```\n' + log.replace(/\u001B\[\d+m/g, '') + '```';
			}

			if (ping && this.argv.discord.ping) {
				content += `\n<@${this.argv.discord.ping}>`;
			}

			json = {content};
		}

		let url = this.argv.discord.webhook;
		if (messageId) {
			url += '/messages/' + messageId;
		}

		try {
			const {body} = await got(url, {
				method: messageId ? 'PATCH' : 'POST',
				searchParams: {
					wait: true,
				},
				json,
				responseType: 'json',
			});

			return (message, log, ping) => this.postWebHook(message, log, ping, body.id);
		} catch (error) {
			this.webhookErrors.push(error);
		}
	}
}
