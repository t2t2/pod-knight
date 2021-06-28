# Pod Knight

A quick podcast episode processor for simple edits and quick uploads

* Cuts episode into parts based on timestamps
* Processes parts into files for publishing
* Uploads files and raw sources to S3-compatible targets
* Reports status into discord webhooks so starting the process and then leaving the computer is a valid choice.
* Supports hardware acceleration (nvidia)

## Requirements

* [node.js](https://nodejs.org/en/) v16 or newer
* [ffmpeg](https://ffmpeg.org/)
  * Must be available on path (can run `ffmpeg -version` on command line)

## Installation

```
npm install -g @t2t2/pod-knight
```

## Usage

First generate a preset which will store configuration per show:

```
pod-knight create:preset my-great-show
```

This generates file `my-great-show.json5` which you can edit to configure settings relevant to processing this show.

Then to use it run:

```
pod-knight --preset <preset> <input-file> <output-base> <...cuts>
```

Additionally `--start / -s <timestamp>` and `--end / -e <timestamp>` can be used to cut beginning and end.

## Example

```
pod-knight --preset ./my-great-show ./stream-recording.mp4 MGS001 -s 00:05:04 01:02:13 02:04:45 -e 03:11:23
```

This will cut into:

```
Part 1: 00:05:04.000 - 01:02:13.000 (duration: 00:57:09.000)  MGS001_pre
Part 2: 01:02:13.000 - 02:04:45.000 (duration: 01:02:32.000)  MGS001
Part 3: 02:04:45.000 - 03:11:23.000 (duration: 01:06:38.000)  MGS001_post
```

And then process into uploads:

```
MGS001/MGS001_pre.mp4 (video)
MGS001/MGS001_pre.mp3 (audio)
MGS001/MGS001.mp4 (video)
MGS001/MGS001.mp3 (audio)
MGS001/MGS001_post.mp4 (video)
MGS001/MGS001_post.mp3 (audio)
```
