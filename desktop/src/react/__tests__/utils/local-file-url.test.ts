import { describe, expect, it } from 'vitest';
import { localFilePathToUrl } from '../../utils/local-file-url';

describe('localFilePathToUrl', () => {
  it('converts Windows drive paths to browser-loadable file URLs', () => {
    expect(localFilePathToUrl('E:\\Codia-professional\\desktop\\src\\assets\\codia.png'))
      .toBe('file:///E:/Codia-professional/desktop/src/assets/codia.png');
  });

  it('encodes spaces without corrupting the drive prefix', () => {
    expect(localFilePathToUrl('C:\\Program Files\\Codia\\icon.png'))
      .toBe('file:///C:/Program%20Files/Codia/icon.png');
  });
});
