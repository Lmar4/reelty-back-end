import { promises as fs } from "fs";

jest.spyOn(fs, "readFile").mockImplementation(async () => {
  const buffer = await require("sharp")({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .jpeg()
    .toBuffer();
  return buffer;
});
