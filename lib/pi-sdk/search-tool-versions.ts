/** Official GitHub release asset digests, verified 2026-10-20. */
export const SEARCH_TOOL_RELEASES = {
  rg: {
    version: '15.2.0', source: 'https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0',
    digests: {
      'darwin-arm64': '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
      'darwin-x64': 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
      'linux-arm64': 'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d',
      'linux-x64': '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
      'win32-arm64': 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
      'win32-x64': '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    },
  },
  fd: {
    version: '10.5.0', source: 'https://github.com/sharkdp/fd/releases/tag/v10.5.0',
    digests: {
      'darwin-arm64': 'b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12',
      'darwin-x64': '7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590',
      'linux-arm64': 'c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c',
      'linux-x64': 'a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95',
      'win32-arm64': 'a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6',
      'win32-x64': 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7',
    },
  },
} as const;
