// @ts-nocheck
/**
 * MoodParser parses mood tags from streaming text.
 *
 * Supported tags:
 *   <mood></mood>
 *   <mod></mod>
 *   <pulse></pulse>
 *
 * All supported tags emit the same event stream:
 *   mood_start / mood_text / mood_end
 *
 * Usage:
 *   const parser = new MoodParser();
 *   parser.feed(delta, (evt) => {
 *     // evt: { type: 'text', data } | { type: 'mood_start' } | { type: 'mood_text', data } | { type: 'mood_end' }
 *   });
 */

const TAGS = ["mood", "mod", "pulse"];

/** */
function trailingPrefixLen(buffer, target) {
  const maxCheck = Math.min(buffer.length, target.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (buffer.endsWith(target.slice(0, len))) return len;
  }
  return 0;
}

function trailingPrefixLenIgnoreCase(buffer, target) {
  const lowerBuffer = buffer.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const maxCheck = Math.min(buffer.length, target.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (lowerBuffer.endsWith(lowerTarget.slice(0, len))) return len;
  }
  return 0;
}

export class MoodParser {
  constructor() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null; // 当前打开的标签名
  }

  /**
  *
   * @param {string} delta
    *
   */
  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

 /** 强制输出 buffer 中剩余内-*/
  flush(emit) {
    if (this.buffer) {
      if (this.inMood) {
        emit({ type: "mood_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inMood) {
      emit({ type: "mood_end" });
      this.inMood = false;
      this._currentTag = null;
    }
  }

  reset() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null;
  }

  _trailingPrefixLen(buffer, target) {
    return trailingPrefixLen(buffer, target);
  }

  /**
  *
   */
  _findOpenTag() {
    let best = null;
    const lowerBuffer = this.buffer.toLowerCase();
    for (const tag of TAGS) {
      const openTag = `<${tag}>`;
      const idx = lowerBuffer.indexOf(openTag);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { tag, idx, openTag };
      }
    }
    return best;
  }

  /**
  *
   */
  _maxTrailingPrefix() {
    let max = 0;
    for (const tag of TAGS) {
      const len = trailingPrefixLenIgnoreCase(this.buffer, `<${tag}>`);
      if (len > max) max = len;
    }
    return max;
  }

 /** 内部：尽可能多地-buffer 中提取完整事-*/
  _drain(emit) {
    while (this.buffer.length > 0) {
 // mood 刚结束时，裁掉前导换-
      if (this._justEndedMood && !this.inMood) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEndedMood = false;
        if (!this.buffer.length) break;
      }

      if (!this.inMood) {
        //
        const found = this._findOpenTag();
        if (found) {
          const before = this.buffer.slice(0, found.idx);
          if (before) emit({ type: "text", data: before });
          emit({ type: "mood_start" });
          this.inMood = true;
          this._currentTag = found.tag;
          this.buffer = this.buffer.slice(found.idx + found.openTag.length);
          continue;
        }
 // buffer 末尾可能是某个开始标签的前缀
        const holdLen = this._maxTrailingPrefix();
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
 // 寻找对应的关闭标-
        const closeTag = `</${this._currentTag}>`;
        const idx = this.buffer.toLowerCase().indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "mood_text", data: content });
          emit({ type: "mood_end" });
          this.inMood = false;
          this._justEndedMood = true;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          this._currentTag = null;
          continue;
        }
 // buffer 末尾可能是关闭标签的前缀
        const moodHoldLen = trailingPrefixLenIgnoreCase(this.buffer, closeTag);
        if (moodHoldLen > 0) {
          const safe = this.buffer.slice(0, -moodHoldLen);
          if (safe) emit({ type: "mood_text", data: safe });
          this.buffer = this.buffer.slice(-moodHoldLen);
          break;
        }
        emit({ type: "mood_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
  *
 *
 * 链在 MoodParser 之前（最外层），输出事件流：
 *   think_start / think_text { data } / think_end
  *
 *
  *
 */
const THINK_TAGS = ["think", "thinking", "reflect"];
const THINK_OPEN_SUFFIXES = [">", "<|message|>"];

function thinkOpenTagsFor(tag) {
  return THINK_OPEN_SUFFIXES.map((suffix) => `<${tag}${suffix}`);
}

export class ThinkTagParser {
  constructor() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    this._currentTag = null;
    this._hasVisibleText = false;
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    this._drain(emit, true);
    if (this.buffer) {
      emit({ type: this.inThink ? "think_text" : "text", data: this.buffer });
      if (!this.inThink) this._hasVisibleText = true;
      this.buffer = "";
    }
    if (this.inThink) {
      emit({ type: "think_end" });
      this.inThink = false;
      this._currentTag = null;
    }
  }

  reset() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    this._currentTag = null;
    this._hasVisibleText = false;
  }

  _findOpenTag() {
    let best = null;
    const lowerBuffer = this.buffer.toLowerCase();
    for (const tag of THINK_TAGS) {
      for (const openTag of thinkOpenTagsFor(tag)) {
        const idx = lowerBuffer.indexOf(openTag);
        if (idx !== -1 && (best === null || idx < best.idx)) {
          best = { tag, idx, openTag };
        }
      }
    }
    return best;
  }

  _findCloseTag() {
    let best = null;
    const lowerBuffer = this.buffer.toLowerCase();
    for (const tag of THINK_TAGS) {
      const closeTag = `</${tag}>`;
      const idx = lowerBuffer.indexOf(closeTag);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { tag, idx, closeTag };
      }
    }
    return best;
  }

  _maxTrailingPrefix() {
    let max = 0;
    for (const tag of THINK_TAGS) {
      for (const openTag of thinkOpenTagsFor(tag)) {
        const openLen = trailingPrefixLenIgnoreCase(this.buffer, openTag);
        if (openLen > max) max = openLen;
      }
      const closeLen = trailingPrefixLenIgnoreCase(this.buffer, `</${tag}>`);
      if (closeLen > max) max = closeLen;
    }
    return max;
  }

  _emitVisible(emit, text) {
    if (!text) return;
    emit({ type: "text", data: text });
    this._hasVisibleText = true;
  }

  _drain(emit, flushing = false) {
    while (this.buffer.length > 0) {
 // think 刚结束时裁掉前导换行
      if (this._justEnded && !this.inThink) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEnded = false;
        if (!this.buffer.length) break;
      }

      if (!this.inThink) {
        const found = this._findOpenTag();
        const closeFound = this._findCloseTag();
        if (closeFound && (!found || closeFound.idx < found.idx)) {
          const before = this.buffer.slice(0, closeFound.idx);
          if (before && !this._hasVisibleText) {
            emit({ type: "think_start" });
            emit({ type: "think_text", data: before });
            emit({ type: "think_end" });
          } else {
            this._emitVisible(emit, before);
          }
          this._justEnded = true;
          this.buffer = this.buffer.slice(closeFound.idx + closeFound.closeTag.length);
          continue;
        }
        if (found) {
          const before = this.buffer.slice(0, found.idx);
          this._emitVisible(emit, before);
          emit({ type: "think_start" });
          this.inThink = true;
          this._currentTag = found.tag;
          this.buffer = this.buffer.slice(found.idx + found.openTag.length);
          continue;
        }
 // buffer 末尾可能是某个开始标签的前缀
        const holdLen = this._maxTrailingPrefix();
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          this._emitVisible(emit, safe);
          this.buffer = flushing ? "" : this.buffer.slice(-holdLen);
          break;
        }
        this._emitVisible(emit, this.buffer);
        this.buffer = "";
      } else {
        const closeTag = `</${this._currentTag}>`;
        const idx = this.buffer.toLowerCase().indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "think_text", data: content });
          emit({ type: "think_end" });
          this.inThink = false;
          this._justEnded = true;
          this._currentTag = null;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLenIgnoreCase(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "think_text", data: safe });
          this.buffer = flushing ? "" : this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "think_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
  *
 *
  *
 *   card_text { data }
 *   card_end
  *
 */
const CARD_ATTR_RE = /(\w+)="([^"]*)"/g;

export class CardParser {
  constructor() {
    this.inCard = false;
    this.buffer = "";
    this._attrs = null;
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    if (this.buffer) {
      if (this.inCard) {
        emit({ type: "card_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inCard) {
      emit({ type: "card_end" });
      this.inCard = false;
      this._attrs = null;
    }
  }

  reset() {
    this.inCard = false;
    this.buffer = "";
    this._attrs = null;
  }

  _parseAttrs(tag) {
    const attrs = {};
    let m;
    CARD_ATTR_RE.lastIndex = 0;
    while ((m = CARD_ATTR_RE.exec(tag)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  _findCardOpen() {
 //
    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const idx = this.buffer.indexOf("<card", searchFrom);
      if (idx === -1) return -1;
      const after = this.buffer[idx + 5];
      if (after === undefined || after === " " || after === ">" || after === "\n" || after === "\t") return idx;
      searchFrom = idx + 1;
    }
    return -1;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      if (!this.inCard) {
        // Look for complete opening tag <card ... > (with word boundary)
        const openIdx = this._findCardOpen();
        if (openIdx !== -1) {
          // Check if the full opening tag is present (find closing >)
          const closeAngle = this.buffer.indexOf(">", openIdx);
          if (closeAngle !== -1) {
            const before = this.buffer.slice(0, openIdx);
            if (before) emit({ type: "text", data: before });
            const openTag = this.buffer.slice(openIdx, closeAngle + 1);
            this._attrs = this._parseAttrs(openTag);
            emit({ type: "card_start", attrs: this._attrs });
            this.inCard = true;
            this.buffer = this.buffer.slice(closeAngle + 1);
            continue;
          }
 //
          const before = this.buffer.slice(0, openIdx);
          if (before) emit({ type: "text", data: before });
          this.buffer = this.buffer.slice(openIdx);
          break;
        }
        // Check trailing prefix for partial <card
        const holdLen = trailingPrefixLen(this.buffer, "<card");
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
 //
        const closeTag = "</card>";
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "card_text", data: content });
          emit({ type: "card_end" });
          this.inCard = false;
          this._attrs = null;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLen(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "card_text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "card_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}
