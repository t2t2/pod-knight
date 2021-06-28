#!/usr/bin/env node
import {access, copyFile} from 'node:fs/promises';
import {constants as fsConstants, readFileSync} from 'node:fs';

import JSON5 from 'json5';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import EpisodeProcessor from './episode-processor.js';

yargs(hideBin(process.argv))
	.command({
		command: '$0 <source> <output-base> [cuts..]',
		desc: 'Process source into published episode',
		builder: yargs => {
			yargs.positional('source', {
				desc: 'Source recording file',
				type: 'string',
			});
			yargs.positional('outputBase', {
				desc: 'Base name for folder and output filenames',
				type: 'string',
			});
			yargs.positional('cuts', {
				desc: 'Timestamps at which cuts are made between parts (for example to make preshow, show and postshow)',
				type: 'string',
			});
			yargs.config('preset', 'Use preset', configPath => JSON5.parse(readFileSync(configPath, 'utf-8')));
			yargs.option('start', {
				alias: 's',
				type: 'string',
				describe: 'Start timestamp for first part',
			});
			yargs.option('end', {
				alias: 'e',
				type: 'string',
				describe: 'End timestamp for last part',
			});
			yargs.option('force', {
				alias: 'f',
				type: 'boolean',
				describe: 'Skip confirmation on encoding plan',
			});
			yargs.option('hwEnc', {
				type: 'string',
				// eslint-disable-next-line unicorn/no-null
				choices: [null, 'nvidia'],
				describe: 'Use hardware encoder',
			});
			yargs.option('upload', {
				type: 'array',
				hidden: true,
				demandOption: 'Missing upload configration (missing preset?)',
				describe: 'Formats configuration',
			});
			yargs.option('formats', {
				type: 'array',
				hidden: true,
				demandOption: 'Missing output formats (missing preset?)',
				describe: 'Formats configuration',
			});
			yargs.option('parts', {
				type: 'array',
				hidden: true,
				describe: 'Parts configuration',
			});
		},
		handler: async argv => {
			const processor = new EpisodeProcessor(argv);

			await processor.run();
		},
	})
	.command({
		command: 'create:preset <filename>',
		desc: 'Create a preset file',
		builder: yargs => {
			yargs.positional('filename', {
				desc: 'Preset filename',
				type: 'string',
			});
		},
		handler: async ({filename}) => {
			if (!filename.endsWith('.json5')) {
				filename += '.json5';
			}

			try {
				await access(filename, fsConstants.F_OK);

				throw new Error(`Profile file ${filename} already exists`);
			} catch (error) {
				if (error.code !== 'ENOENT') {
					throw error;
				}
			}

			await copyFile(new URL('preset.json5.tpl', import.meta.url), filename);
			console.log(`Preset ${filename} created, go forth and edit it`);
		},
	})
	.demandCommand()
	.example([
		['$0 --preset show.json recording.mp4 AA001 -s 00:10:01 01:02:12 02:12:30 -e 03:04:56', 'Processes recording.mp4 into 3 videos using show.json profile'],
	])
	.showHelpOnFail(false)
	.parse();

