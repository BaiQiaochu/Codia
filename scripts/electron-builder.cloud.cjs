// Cloud builds keep the source version and never use local signing credentials.
const { build } = require('../package.json');

module.exports = {
  ...build,
  publish: [{ provider: 'github', owner: 'BaiQiaochu', repo: 'Codia' }],
  mac: {
    ...build.mac,
    // Ad-hoc signing supports Apple Silicon; Developer ID/notarization is separate.
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
  },
};
