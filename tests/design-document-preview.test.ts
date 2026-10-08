import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESIGN_DOCUMENT_EXTENSIONS,
  parseDesignDocumentPreview,
} from "../shared/design-document-preview.ts";

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("design document preview parser", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-design-preview-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("declares CAD, 3D scene, and XMind extensions as previewable", () => {
    expect(DESIGN_DOCUMENT_EXTENSIONS).toEqual(expect.arrayContaining([
      "dwg",
      "dxf",
      "max",
      "3ds",
      "fbx",
      "obj",
      "xmind",
    ]));
  });

  it("extracts readable DXF layers and entity counts without an external CAD app", async () => {
    const filePath = path.join(tmpDir, "floor-plan.dxf");
    fs.writeFileSync(filePath, [
      "0",
      "SECTION",
      "2",
      "ENTITIES",
      "0",
      "LINE",
      "8",
      "Walls",
      "0",
      "CIRCLE",
      "8",
      "Doors",
      "0",
      "ENDSEC",
      "0",
      "EOF",
    ].join("\n"));

    const preview = await parseDesignDocumentPreview(filePath);

    expect(preview).toMatchObject({
      kind: "cad",
      format: "DXF",
      canRenderNatively: true,
    });
    expect(preview.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Layers", items: expect.arrayContaining(["Walls", "Doors"]) }),
      expect.objectContaining({ title: "Entities", items: expect.arrayContaining(["LINE: 1", "CIRCLE: 1"]) }),
    ]));
  });

  it("extracts XMind topics from a workbook archive", async () => {
    const filePath = path.join(tmpDir, "roadmap.xmind");
    fs.writeFileSync(filePath, buildZip([[
      "content.json",
      JSON.stringify([{
        title: "Product roadmap",
        rootTopic: {
          title: "G-SAP",
          children: {
            attached: [
              { title: "Reader" },
              { title: "CAD", children: { attached: [{ title: "DXF" }] } },
            ],
          },
        },
      }]),
    ]]));

    const preview = await parseDesignDocumentPreview(filePath);

    expect(preview).toMatchObject({
      kind: "mindmap",
      format: "XMind",
      canRenderNatively: true,
    });
    expect(preview.sections[0].items).toEqual([
      "Product roadmap",
      "G-SAP",
      "  Reader",
      "  CAD",
      "    DXF",
    ]);
  });

  it("summarizes proprietary 3DMAX files without pretending to render them", async () => {
    const filePath = path.join(tmpDir, "scene.max");
    fs.writeFileSync(filePath, Buffer.concat([
      Buffer.from("3D Studio MAX\0"),
      Buffer.from("Camera_Main\0WallMesh\0Material_Wood\0"),
    ]));

    const preview = await parseDesignDocumentPreview(filePath);

    expect(preview).toMatchObject({
      kind: "three-d",
      format: "3ds Max",
      canRenderNatively: false,
    });
    expect(preview.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Readable strings", items: expect.arrayContaining(["3D Studio MAX", "Camera_Main", "WallMesh", "Material_Wood"]) }),
    ]));
  });

  it("rejects oversized binary design files before reading them", async () => {
    const filePath = path.join(tmpDir, "huge.dwg");
    fs.writeFileSync(filePath, Buffer.alloc(33 * 1024 * 1024));

    await expect(parseDesignDocumentPreview(filePath)).rejects.toMatchObject({
      code: "DESIGN_PREVIEW_FILE_TOO_LARGE",
    });
  });
});
