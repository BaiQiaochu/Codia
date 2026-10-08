import {
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "../../../lib/providers/media-schema-helpers.ts";

export const id = "jimeng-cli";
export const displayName = "Jimeng CLI";
export const authType = "none";

const IMAGE_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
const VIDEO_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];

const IMAGE_PROPERTIES = {
  ratio: enumParam(IMAGE_RATIOS, "3:2"),
  resolution: enumParam(["2k", "4k"], "4k"),
};
const IMAGE_DEFAULTS = { ratio: "3:2", resolution: "4k" };

function imageMode(id, label, inputLimits) {
  return mediaMode(id, label, IMAGE_PROPERTIES, IMAGE_DEFAULTS, inputLimits);
}

function textVideoProperties(resolutions = ["720p"]) {
  return {
    ratio: enumParam(VIDEO_RATIOS, "16:9"),
    duration: integerParam({ minimum: 4, maximum: 15, defaultValue: 5 }),
    video_resolution: enumParam(resolutions, "720p"),
  };
}

function imageVideoProperties({ min, max, resolutions = ["720p"] }) {
  return {
    duration: integerParam({ minimum: min, maximum: max, defaultValue: 5 }),
    video_resolution: enumParam(resolutions, "720p"),
  };
}

function text2videoMode(resolutions = ["720p"]) {
  return mediaMode(
    "text2video",
    "Text to video",
    textVideoProperties(resolutions),
    { duration: 5, ratio: "16:9", video_resolution: "720p" },
    noReferenceImages(),
  );
}

function image2videoMode({ min = 4, max = 15, resolutions = ["720p"] } = {}) {
  return mediaMode(
    "image2video",
    "Image to video",
    imageVideoProperties({ min, max, resolutions }),
    { duration: 5, video_resolution: "720p" },
    referenceImages({ max: 1 }),
  );
}

function seedanceModel(id, displayName, resolutions = ["720p"]) {
  return {
    id,
    displayName,
    protocolId: "jimeng-cli-videos",
    inputs: ["text", "image"],
    outputs: ["video"],
    supportsAsync: true,
    modes: [
      text2videoMode(resolutions),
      image2videoMode({ min: 4, max: 15, resolutions }),
    ],
    ratios: VIDEO_RATIOS,
    resolutions,
    duration: { min: 4, max: 15 },
  };
}

function imageOnlyVideoModel(id, displayName, min, max) {
  return {
    id,
    displayName,
    protocolId: "jimeng-cli-videos",
    inputs: ["image"],
    outputs: ["video"],
    supportsAsync: true,
    modes: [image2videoMode({ min, max })],
    resolutions: ["720p"],
    duration: { min, max },
  };
}

export const capabilities = {
  chat: {
    projection: "none",
    runtimeProviderId: "jimeng-cli",
    displayProviderId: "jimeng-cli",
  },
  media: {
    imageGeneration: {
      defaultModelId: "jimeng-image-5.0",
      models: [
        {
          id: "jimeng-image-5.0",
          displayName: "Jimeng Image 5.0",
          protocolId: "jimeng-cli-images",
          inputs: ["text", "image"],
          outputs: ["image"],
          supportsEdit: true,
          modes: [
            imageMode("text2image", "Text to image", noReferenceImages()),
            imageMode("image2image", "Image to image", referenceImages()),
          ],
          ratios: IMAGE_RATIOS,
          resolutions: ["2k", "4k"],
        },
      ],
    },
    videoGeneration: {
      defaultModelId: "seedance2.0fast",
      models: [
        seedanceModel("seedance2.0fast", "Seedance 2.0 Fast"),
        seedanceModel("seedance2.0", "Seedance 2.0"),
        seedanceModel("seedance2.0fast_vip", "Seedance 2.0 Fast VIP"),
        seedanceModel("seedance2.0_vip", "Seedance 2.0 VIP", ["720p", "1080p"]),
        imageOnlyVideoModel("3.0", "Jimeng Video 3.0", 3, 10),
        imageOnlyVideoModel("3.0fast", "Jimeng Video 3.0 Fast", 3, 10),
        imageOnlyVideoModel("3.0pro", "Jimeng Video 3.0 Pro", 3, 10),
        imageOnlyVideoModel("3.5pro", "Jimeng Video 3.5 Pro", 4, 12),
      ],
    },
  },
};
