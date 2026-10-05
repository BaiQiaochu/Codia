/**
  *
 *
  * */

/** */
const HARD_PATTERNS = [
 //

 //

  // PEM 绉侀挜
  { name: "private_key", regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },

 // 信用卡号（Luhn 不做，但 4 -4 位数字检测）
  { name: "credit_card", regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },

 // 中国身份证号-8位）
  { name: "id_card", regex: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },

 //
];

/**
 * 棢测文本中的敏感信息并脱敏
  * */
export function scrubPII(text) {
  if (!text) return { cleaned: text, detected: [] };

  const detected = [];
  let cleaned = text;

  for (const { name, regex } of HARD_PATTERNS) {
 //
    regex.lastIndex = 0;
    if (regex.test(cleaned)) {
      detected.push(name);
      regex.lastIndex = 0;
      cleaned = cleaned.replace(regex, "[REDACTED]");
    }
  }

  return { cleaned, detected };
}

/**
 * 棢测是否包含敏感信息（不修改文本）
 * @param {string} text
 * @returns {boolean}
 */
export function hasPII(text) {
  if (!text) return false;
  for (const { regex } of HARD_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
