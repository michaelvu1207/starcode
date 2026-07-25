#!/usr/bin/env node
/**
 * Fork-owned app-icon export: a crescent moon on deep ink, per release channel.
 *
 * WHY THIS EXISTS ALONGSIDE `export-brand-icons.ts`
 * The upstream pipeline (`vp run icons:export`) is the canonical one and stays
 * the source of truth: it renders the per-channel `app-icon.icon` projects
 * under `assets/` through Apple's Icon Composer (`ictool`), which applies the
 * glass, shadow, and translucency treatments a plain SVG rasterizer cannot
 * reproduce. It also hard-fails without Icon Composer installed, which ships
 * with Xcode 26+.
 *
 * This script produces the same output files from a flat vector, so the fork
 * has a correct icon on machines without Icon Composer — which is every machine
 * in this fleet today. The result is a flat mark rather than a glass composite.
 * Once Icon Composer is available, `vp run icons:export` supersedes this for the
 * macOS and iOS renditions; favicons are flat either way. The `.icon` projects
 * carry the same crescent, so running either pipeline yields the same design.
 *
 * The output *filenames* stay on upstream's names ("black", "blueprint") on
 * purpose. They are internal identifiers read by `scripts/lib/brand-assets.ts`
 * and the desktop build; renaming them buys nothing and churns both.
 *
 * Usage:  node scripts/export-starcode-icons.ts
 * Needs:  rsvg-convert on PATH (`brew install librsvg`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

/**
 * The wordmark crescent (see `StarcodeWordmark.tsx`), scaled from its 20-unit
 * box by 36.25 about the 1024 canvas centre. The remaining ~220px of padding is
 * what keeps the mark clear of the iOS and macOS corner masks. Tilted, because
 * an upright crescent reads as the letter C.
 */
const CRESCENT_PATH =
  "M415.53 238.51 A290 290 0 1 0 785.49 608.47 A268.25 268.25 0 0 1 415.53 238.51 Z";

/**
 * One crescent, three tints. The channel signal has to survive being 16px in a
 * browser tab, where the field colour is nearly invisible and the mark is not —
 * so the mark carries the difference, not the background.
 */
interface Channel {
  readonly directory: string;
  readonly field: string;
  readonly moon: string;
  /** Upstream's PNG filename stem for this channel. */
  readonly prefix: string;
  /** Upstream's .ico filename stem, which differs from the PNG stem for prod. */
  readonly icoPrefix: string;
}

const CHANNELS: ReadonlyArray<Channel> = [
  { directory: "prod", field: "#12141f", moon: "#f0d9a0", prefix: "black", icoPrefix: "t3-black" },
  {
    directory: "dev",
    field: "#12141f",
    moon: "#93b1de",
    prefix: "blueprint",
    icoPrefix: "blueprint",
  },
  {
    directory: "nightly",
    field: "#241c3a",
    moon: "#e9e3d6",
    prefix: "nightly",
    icoPrefix: "nightly",
  },
];

const FAVICON_ICO_SIZES = [16, 32, 48] as const;

class StarcodeIconExportError extends Data.TaggedError("StarcodeIconExportError")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

function markSvg(channel: Channel): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${channel.field}"/>
  <g transform="rotate(-20 512 512)">
    <path d="${CRESCENT_PATH}" fill="${channel.moon}"/>
  </g>
</svg>
`;
}

const rasterize = Effect.fn("starcodeIcons.rasterize")(function* (
  svgPath: string,
  size: number,
  outputPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("rsvg-convert", [
        "-w",
        String(size),
        "-h",
        String(size),
        svgPath,
        "-o",
        outputPath,
      ]),
    )
    .pipe(
      Effect.mapError(
        () =>
          new StarcodeIconExportError({
            operation: "rasterize",
            detail:
              "rsvg-convert is required to rasterize the icon. Install it with " +
              "`brew install librsvg`, or run the canonical pipeline instead: " +
              "`vp run icons:export` (needs Icon Composer).",
          }),
      ),
    );
  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new StarcodeIconExportError({ operation: "rasterize", detail: `${String(cause)}` }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new StarcodeIconExportError({
      operation: "rasterize",
      detail: `rsvg-convert exited with ${exitCode} for ${svgPath} at ${size}px`,
    });
  }
});

export const exportStarcodeIcons = Effect.fn("starcodeIcons.export")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* path
    .fromFileUrl(new URL("..", import.meta.url))
    .pipe(
      Effect.mapError(
        (cause) =>
          new StarcodeIconExportError({ operation: "repository-root", detail: `${String(cause)}` }),
      ),
    );
  const scratch = yield* fs
    .makeTempDirectoryScoped({ prefix: "starcode-icons-" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new StarcodeIconExportError({ operation: "scratch", detail: `${String(cause)}` }),
      ),
    );

  const written: Array<string> = [];
  const write = Effect.fn("starcodeIcons.write")(function* (
    relativePath: string,
    contents: Uint8Array,
  ) {
    yield* fs
      .writeFile(path.join(repositoryRoot, relativePath), contents)
      .pipe(
        Effect.mapError(
          (cause) =>
            new StarcodeIconExportError({ operation: relativePath, detail: `${String(cause)}` }),
        ),
      );
    written.push(relativePath);
  });

  /** Renders one size and returns its bytes. */
  const renderPng = Effect.fn("starcodeIcons.renderPng")(function* (
    svgPath: string,
    label: string,
    size: number,
  ) {
    const outputPath = path.join(scratch, `${label}-${size}.png`);
    yield* rasterize(svgPath, size, outputPath);
    return yield* fs
      .readFile(outputPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new StarcodeIconExportError({ operation: outputPath, detail: `${String(cause)}` }),
        ),
      );
  });

  const renderIco = Effect.fn("starcodeIcons.renderIco")(function* (
    svgPath: string,
    label: string,
    sizes: ReadonlyArray<number>,
  ) {
    const images = yield* Effect.forEach(sizes, (size) =>
      renderPng(svgPath, label, size).pipe(
        Effect.map((contents) => ({ size, contents: Buffer.from(contents) })),
      ),
    );
    return encodePngIco(images);
  });

  for (const channel of CHANNELS) {
    const svgPath = path.join(scratch, `${channel.directory}.svg`);
    yield* fs
      .writeFileString(svgPath, markSvg(channel))
      .pipe(
        Effect.mapError(
          (cause) =>
            new StarcodeIconExportError({ operation: svgPath, detail: `${String(cause)}` }),
        ),
      );

    // Desktop renditions. iOS, macOS, and universal share the same flat art
    // here; only Icon Composer differentiates them, via per-platform effects.
    const full = yield* renderPng(svgPath, channel.directory, 1024);
    for (const platform of ["ios", "macos", "universal"]) {
      yield* write(`assets/${channel.directory}/${channel.prefix}-${platform}-1024.png`, full);
    }

    for (const [size, name] of [
      [16, "web-favicon-16x16"],
      [32, "web-favicon-32x32"],
      [180, "web-apple-touch-180"],
    ] as ReadonlyArray<readonly [number, string]>) {
      yield* write(
        `assets/${channel.directory}/${channel.prefix}-${name}.png`,
        yield* renderPng(svgPath, channel.directory, size),
      );
    }

    // Multi-resolution .ico bundles, encoded by the repo's own encoder so the
    // byte layout matches whatever the canonical pipeline produces.
    yield* write(
      `assets/${channel.directory}/${channel.icoPrefix}-web-favicon.ico`,
      yield* renderIco(svgPath, channel.directory, FAVICON_ICO_SIZES),
    );
    yield* write(
      `assets/${channel.directory}/${channel.icoPrefix}-windows.ico`,
      yield* renderIco(svgPath, channel.directory, WINDOWS_ICON_SIZES),
    );

    // `apps/web/public` is the dev server's icon set — the one a browser tab
    // shows while working locally. Mirrors DEVELOPMENT_PUBLIC_ICON_OVERRIDES.
    if (channel.directory === "dev") {
      yield* write("apps/web/public/favicon-16x16.png", yield* renderPng(svgPath, "public", 16));
      yield* write("apps/web/public/favicon-32x32.png", yield* renderPng(svgPath, "public", 32));
      yield* write(
        "apps/web/public/apple-touch-icon.png",
        yield* renderPng(svgPath, "public", 180),
      );
      yield* write(
        "apps/web/public/favicon.ico",
        yield* renderIco(svgPath, "public", FAVICON_ICO_SIZES),
      );
    }
  }

  for (const relativePath of written) {
    yield* Console.log(`wrote ${relativePath}`);
  }
  yield* Console.log(`\n${written.length} file(s).`);
});

export const exportStarcodeIconsCommand = Command.make("export-starcode-icons", {}, () =>
  exportStarcodeIcons().pipe(Effect.scoped),
).pipe(Command.withDescription("Export starcode crescent app icons for every release channel."));

if (import.meta.main) {
  Command.run(exportStarcodeIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
