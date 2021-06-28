import {lookup as mimeLookup} from 'mime-types';

/**
 * Custom multipart options (larger partSize as we have bigger files)
 */
export function getUploadOptions(params, episode, publicBucket = false) {
	return {
		params: {
			...params,
			ACL: publicBucket ? 'public-read' : 'private',
			ContentType: mimeLookup(params.Key),
			Metadata: {
				...params.Metadata,
				'x-amz-meta-episode': episode,
			},
		},
		partSize: 1024 * 1024 * 25,
	};
}

export function updateTaskWithUpload(task, upload) {
	upload.on('httpUploadProgress', event => {
		const pct = ((event.loaded / event.total) * 100).toFixed(0);
		task.output = `${event.loaded} / ${event.total} (${pct}%)`;
	});
}
