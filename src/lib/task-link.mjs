export function imdTaskUrl(jobId) {
  return jobId ? 'https://explorer.imd.fun/jobs/' + encodeURIComponent(jobId) : null;
}
