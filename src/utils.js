import {join, sep} from 'node:path';

const HOUR = 60 * 60;
const MINUTE = 60;

export function getPartInfo({start, end, index, partOptions, outputBase}) {
	const prefix = partOptions?.prefix ?? '';
	const suffix = partOptions?.suffix ?? ('_' + (index + 1));

	const filename = prefix + outputBase + suffix;

	return {
		start,
		end,
		index,
		filename,
	};
}

export function getFileName(baseFilename, format) {
	const prefix = format?.prefix ?? '';
	const suffix = format?.suffix ?? '';
	const extension = format?.type === 'audio' ? 'mp3' : 'mp4';

	return `${prefix}${baseFilename}${suffix}.${extension}`;
}

/**
 * Parse duration string into seconds
 * (hh:)(mm:)ss(.ms)
 *
 * @param {string} duration Duration string
 * @returns {number} Number in seconds
 */
export function parseDuration(duration) {
	const parts = duration.split(':');

	if (parts.length > 3) {
		throw new Error(`Invalid duration (too many :) ${duration}`);
	}

	// eslint-disable-next-line unicorn/no-array-reduce
	return parts.reduce((sum, part) => (sum * 60) + Number.parseFloat(part), 0);
}

/**
 * Format duration from seconds into string
 * hh:mm:ss.ms
 *
 * @param {number} duration Duration in seconds
 * @returns {string} Duration string
 */
export function formatDuration(duration) {
	const hours = Math.floor(duration / HOUR);
	const minutes = Math.abs(Math.floor((duration % HOUR) / MINUTE));
	const seconds = Math.abs(Math.floor(duration % MINUTE));
	const ms = duration % 1;

	return hours.toString().padStart(2, '0')
		+ ':' + minutes.toString().padStart(2, '0')
		+ ':' + seconds.toString().padStart(2, '0')
		+ '.' + ms.toFixed(3).slice(ms.toFixed(3).indexOf('.') + 1).padEnd(3, '0');
}

/**
 *
 * @param {...string} parts
 * @returns {string} Joined path
 */
export function joinS3Path(...parts) {
	// Consistent with windows
	return join(...parts.filter(a => a)).replaceAll(sep, '/');
}

export function delay(time) {
	return new Promise(resolve => {
		setTimeout(resolve, time);
	});
}
