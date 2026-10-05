import { describe, expect, it } from 'vitest';
import { localFilePathToUrl } from '../../utils/local-file-url';

describe('localFilePathToUrl', () => {
  it('converts Windows drive paths to browser-loadable file URLs', () => {
    expect(localFilePathToUrl('E:\\G-sap-professional\\desktop\\src\\assets\\G-SAP.png'))
      .toBe('file:///E:/G-sap-professional/desktop/src/assets/G-SAP.png');
  });

  it('encodes spaces without corrupting the drive prefix', () => {
    expect(localFilePathToUrl('C:\\Program Files\\G-SAP\\icon.png'))
      .toBe('file:///C:/Program%20Files/G-SAP/icon.png');
  });
});
