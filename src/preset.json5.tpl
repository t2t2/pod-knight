{
	/**
	 * Use hardware encoding
	 * Values: null, "nvidia"
	 */
	"hwEnc": "nvidia",

	/**
	 * How many ffmpeg processes can be run in parallel
	 *
	 * If audio is set to 0 then it is shared with video queue
	 */
	"parallel": {
		"video": 1,
		"audio": 1,
	},

	/**
	 * S3/-compatible settings
	 * 
	 * options: Configuration for s3 client
	 * private: Settings for bucket where raws are uploaded to
	 * public: Settings for bucket where outputs are uploaded to
	 * - bucket: s3 bucket 
	 * - prefix: Base "directory" for uploaded files
	 */
	"upload": {
		"options": {
			"endpoint": "",
			"credentials": {
				"accessKeyId": "",
				"secretAccessKey": "",
			},
		},
		"private": {
			"bucket": "",
			"prefix": "",
		},
		"public": {
			"bucket": "",
			"prefix": "",
		},
	},

	/**
	 * Settings for parts.
	 * If there's more parts than specified then defaults are used.
	 *
	 * Options:
	 * - prefix: (default: '')
	 * - suffix: (default: '_{part#}')
	 */
	"parts": [
		{"suffix": "_pre"},
		{"suffix": ""},
		{"suffix": "_post"},
	],

	/**
	 * Public output formats for parts
	 * 
	 * Options:
	 * - type: "video" | "audio"
	 * - prefix: (default: "")
	 * - suffix: (default: "")
	 */
	"formats": [
		{"type": "video"},
		{"type": "audio"},
	],

	/**
	 * Discord integration
	 * - webhook: Webhook url
	 * - ping: target to @mention (userid or &roleid)
	 */
	"discord": {
		"webhook": "",
		"ping": "",
	},
}
