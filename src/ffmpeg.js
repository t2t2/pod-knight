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

export function getPartEncodingSettings({start, end}, source, output, hwEnc) {
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
		'-c:v',
		hwEnc === 'nvidia' ? 'h264_nvenc' : 'libx264',
		'-b:v',
		'2500k',
		'-maxrate:v',
		'3500k',
		'-bufsize:v',
		'8M',
		// Audio
		'-c:a',
		'aac',
		// Container
		'-movflags',
		'+faststart',
		// Output
		output,
	];
}

export function getOutputEncodingSettings({
	type = 'video',
}, inputFile, outputFile, hwEnc) {
	// eslint-disable-next-line unicorn/prevent-abbreviations
	let hardwareAccFlags = [];
	let videoFlags;
	let audioFlags;
	let containerFlags = [];

	if (type === 'audio') {
		videoFlags = ['-vn'];
		audioFlags = ['-vn', '-c:a', 'libmp3lame', '-q:a', 7];
	} else {
		hardwareAccFlags = getHwAccelerationFlags(hwEnc);
		audioFlags = ['-c:a', 'aac', '-b:a', '160k'];
		containerFlags = ['-movflags', '+faststart'];
		const bandwith = ['-b:v', '1M', '-maxrate:v', '2M', '-bufsize:v', '4M'];

		// eslint-disable-next-line unicorn/prefer-ternary
		if (hwEnc === 'nvidia') {
			videoFlags = [
				// Resize
				'-vf',
				'scale_cuda=1280:720',
				// Video profile
				'-c:v',
				'h264_nvenc',
				...bandwith,
				'-profile:v',
				'high',
				'-level:v',
				'4.1',
			];
		} else {
			videoFlags = [
				// Resize
				'-vf',
				'scale=1280:720',
				// Video profile
				'-c:v',
				'libx264',
				...bandwith,
				'-pix_fmt',
				'yuv420p',
				'-preset',
				'slow',
				'-profile:v',
				'high',
				'-level:v',
				'4.1',
			];
		}
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
