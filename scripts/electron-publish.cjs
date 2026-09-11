// Loaded through package.json build.extends for every electron-builder entry point.
module.exports = {
  publish: [{
    provider: 'github',
    owner: process.env.CUMORA_GITHUB_OWNER?.trim() || 'guanwenpeng2001-bot',
    repo: process.env.CUMORA_GITHUB_REPO?.trim() || 'cumora',
    releaseType: 'release',
    publishAutoUpdate: true,
  }],
}
