// MP4 edit-list durations use movie timescale; media_time uses track timescale.
// A leading empty edit is a delay, not an invalid/negative trim.
export function editTiming(edits = [], trackScale, movieScale) {
  let movieTime = 0, offset, mediaEnd;
  for (const edit of edits) {
    if (edit.media_rate_integer !== 1 || (edit.media_rate_fraction ?? 0) !== 0) throw new Error('This MP4 uses a non-unit playback-rate edit.');
    const duration = edit.segment_duration / movieScale;
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid MP4 edit duration.');
    if (edit.media_time === -1 && offset === undefined) { movieTime += duration; continue; }
    if (edit.media_time < 0) throw new Error('This MP4 has an empty edit after media playback.');
    const mediaStart = edit.media_time / trackScale;
    const nextOffset = movieTime - mediaStart;
    if (offset !== undefined && (Math.abs(nextOffset - offset) > 0.0001 || Math.abs(mediaStart - mediaEnd) > 0.0001)) throw new Error('This MP4 uses discontinuous media edits.');
    offset = nextOffset;
    mediaEnd = mediaStart + duration;
    movieTime += duration;
  }
  return { trim: offset ? -offset : 0, duration: movieTime };
}
