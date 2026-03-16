// Node.js compatibility shim for @deno/loader WASM bindings.
// Provides Deno.* APIs used by the generated glue code (rs_lib.internal.js)
// using Node.js equivalents.

if (typeof Deno === "undefined") {
  const fs = await import("node:fs");
  const process = await import("node:process");

  // Map Node.js error codes to Deno error names.
  // The WASM code reads error.name to classify errors.
  const nodeCodeToDenoName = {
    ENOENT: "NotFound",
    EEXIST: "AlreadyExists",
    EACCES: "PermissionDenied",
    EPERM: "PermissionDenied",
    ENOTDIR: "NotADirectory",
    EISDIR: "IsADirectory",
    ENOTEMPTY: "NotEmpty",
    ECONNREFUSED: "ConnectionRefused",
    ECONNRESET: "ConnectionReset",
    EADDRINUSE: "AddrInUse",
    ETIMEDOUT: "TimedOut",
    EBADF: "BadResource",
  };

  const toDenoError = (err) => {
    const denoName = nodeCodeToDenoName[err.code];
    if (denoName) {
      err.name = denoName;
    }
    return err;
  };

  const wrapFs = (fn) => {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        throw toDenoError(err);
      }
    };
  };

  const toDenoStat = (path, followSymlinks) => {
    const fn = followSymlinks ? fs.statSync : fs.lstatSync;
    const stat = fn(path);
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
      mtime: stat.mtimeMs ? new Date(stat.mtimeMs) : null,
      atime: stat.atimeMs ? new Date(stat.atimeMs) : null,
      birthtime: stat.birthtimeMs ? new Date(stat.birthtimeMs) : null,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      rdev: stat.rdev,
      blksize: stat.blksize,
      blocks: stat.blocks,
      isBlockDevice: stat.isBlockDevice(),
      isCharDevice: stat.isCharacterDevice(),
      isFifo: stat.isFIFO(),
      isSocket: stat.isSocket(),
    };
  };

  const osMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
    freebsd: "freebsd",
    openbsd: "openbsd",
    sunos: "solaris",
    aix: "aix",
  };

  class FsFile {
    #fd;
    constructor(fd) {
      this.#fd = fd;
    }
    close() {
      fs.closeSync(this.#fd);
    }
    readSync(buffer) {
      return fs.readSync(this.#fd, buffer);
    }
    writeSync(data) {
      return fs.writeSync(this.#fd, data);
    }
  }

  globalThis.Deno = {
    cwd: () => process.default.cwd(),
    env: {
      get: (key) => {
        const val = process.default.env[key];
        return val === undefined ? undefined : val;
      },
    },
    build: {
      os: osMap[process.default.platform] ?? "linux",
    },
    readFileSync: wrapFs((path) => fs.readFileSync(path)),
    writeFileSync: wrapFs((path, data) => fs.writeFileSync(path, data)),
    statSync: wrapFs((path) => toDenoStat(path, true)),
    lstatSync: wrapFs((path) => toDenoStat(path, false)),
    realPathSync: wrapFs((path) => fs.realpathSync(path)),
    readDirSync: wrapFs((path) => {
      const entries = fs.readdirSync(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      }));
    }),
    readLinkSync: wrapFs((path) => fs.readlinkSync(path)),
    mkdirSync: wrapFs((path, recursive) =>
      fs.mkdirSync(path, { recursive: !!recursive })
    ),
    removeSync: wrapFs((path, recursive) =>
      fs.rmSync(path, { recursive: !!recursive, force: true })
    ),
    renameSync: wrapFs((oldPath, newPath) => fs.renameSync(oldPath, newPath)),
    linkSync: wrapFs((oldPath, newPath) => fs.linkSync(oldPath, newPath)),
    symlinkSync: wrapFs((target, path, _type) => fs.symlinkSync(target, path)),
    copyFileSync: wrapFs((src, dst) => fs.copyFileSync(src, dst)),
    chmodSync: wrapFs((path, mode) => fs.chmodSync(path, mode)),
    openSync: wrapFs((path, _options) => {
      const fd = fs.openSync(path, "r");
      return new FsFile(fd);
    }),
    FsFile,
  };
}
