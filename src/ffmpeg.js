import {spawn} from 'node:child_process';
import {EOL} from 'node:os';

export const NEWLINE_REGEX = /\r\n|\r|\n/g;

export function runFFmpeg(args, task) {
	return new Promise((resolve, reject) => {
		const ffmpeg = spawn('ffmpeg', args);

		const output = [];
		let current = '';
		ffmpeg.stderr.on('data', data => {
			const string = data.toString();
			const lines = string.split(NEWLINE_REGEX);

			for (const [index, string_] of lines.entries()) {
				if (index > 0) {
					if (output.length > 1 && current.startsWith('frame=') && output[output.length - 1].startsWith('frame=')) {
						output[output.length - 1] = current;
					} else {
						output.push(current);
					}

					current = '';
				}

				current += string_;
			}

			task.output = output[output.length - 1];

			if (output.length > 100) {
				output.splice(0, output.length - 100);
			}
		});

		ffmpeg.on('close', code => {
			task.output = output.join(EOL);
			if (code > 0) {
				reject(new Error(`ffmpeg exit with ${code}` + EOL + output.join(EOL)));
			}

			resolve();
		});

		ffmpeg.on('error', error => {
			reject(error);
		});
	});
}

function getHwAccelerationFlags(hwEnc) {
	return hwEnc === 'nvidia' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : ['-hwaccel', 'auto'];
}

function getEncodingVideoFlags(settings, hwEnc) {
	const videoFlags = [
		'-c:v',
		hwEnc === 'nvidia' ? 'h264_nvenc' : 'libx264',
		'-b:v',
		settings.bitrate,
		'-maxrate:v',
		settings.maxrate,
		'-bufsize:v',
		settings.buffer,
	];
	const filters = [];

	if (settings.scale) {
		filters.push((hwEnc === 'nvidia' ? 'scale_cuda' : 'scale') + '=' + settings.scale);
	}

	if (settings.fps) {
		videoFlags.push('-r', settings.fps);
	}

	if (filters.length > 0) {
		videoFlags.push('-filter:v', filters.join(','));
	}

	return videoFlags;
}

function getEncodingAudioFlags(settings) {
	const audioFlags = [
		'-c:a',
		settings.codec,
		'-b:a',
		settings.bitrate,
	];

	return audioFlags;
}

// eslint-disable-next-line max-params, unicorn/no-null
export function getPartEncodingSettings({start, end}, source, output, partSettings = {}, hwEnc = null) {
	return [
		'-hide_banner',
		...getHwAccelerationFlags(hwEnc),
		// Seek input
		'-ss',
		start,
		// Input file
		'-i',
		source,
		// End
		'-to',
		end - start,
		// Video
		...getEncodingVideoFlags({
			bitrate: '2500k',
			maxrate: '3500k',
			buffer: '8000k',
			...(partSettings?.video ?? {}),
		}, hwEnc),
		// Audio
		...getEncodingAudioFlags({
			codec: 'aac',
			bitrate: '160k',
			...(partSettings?.audio ?? {}),
		}),
		// Container
		'-movflags',
		'+faststart',
		// Output
		output,
	];
}

export function getOutputEncodingSettings(outputSettings, inputFile, outputFile, hwEnc) {
	// eslint-disable-next-line unicorn/prevent-abbreviations
	let hardwareAccFlags = [];
	let videoFlags;
	let audioFlags;
	let containerFlags = [];

	if (outputSettings.type === 'audio') {
		videoFlags = ['-vn'];
		audioFlags = getEncodingAudioFlags({
			codec: 'libmp3lame',
			bitrate: '128k',
			...(outputSettings?.audio ?? {}),
		});
	} else {
		hardwareAccFlags = getHwAccelerationFlags(hwEnc);
		audioFlags = getEncodingAudioFlags({
			codec: 'aac',
			bitrate: '160k',
			...(outputSettings?.audio ?? {}),
		});
		containerFlags = ['-movflags', '+faststart'];
		videoFlags = [
			...getEncodingVideoFlags({
				bitrate: '1000k',
				maxrate: '2000k',
				buffer: '4000k',
				scale: '1280:720',
				...(outputSettings?.video ?? {}),
			}, hwEnc),
		];

		if (!hwEnc) {
			videoFlags.push(
				'-pix_fmt',
				'yuv420p',
				'-preset',
				'slow',
			);
		}

		videoFlags.push(
			'-profile:v',
			'high',
			'-level:v',
			'4.1',
		);
	}

	return [
		'-hide_banner',
		...hardwareAccFlags,
		// Input file
		'-i',
		inputFile,
		// Codec flags
		...videoFlags,
		...audioFlags,
		...containerFlags,
		outputFile,
	];
}

export class FFMpegQueue {
	constructor(parallel = 1) {
		this.queue = [];
		this.parallel = parallel;
		this.ongoing = 0;
	}

	wait() {
		return new Promise(resolve => {
			this.queue.push(resolve);
			this.check();
		});
	}

	done() {
		this.ongoing--;
		this.check();
	}

	check() {
		if (this.ongoing < this.parallel && this.queue.length > 0) {
			const resolve = this.queue.shift();
			this.ongoing++;
			resolve();
		}
	}
}
