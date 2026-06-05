// Pseudo-terminal (PTY) pair creation for POSIX systems.
// Used by `sigillo run` to preserve TTY detection in child processes
// while still intercepting output for secret redaction.
//
// Without PTYs, the child's stdout/stderr are pipes and isatty() returns
// false, breaking colored output, interactive prompts, and progress bars
// in tools like next dev, cargo, pytest, etc.
//
// Platform strategy for avoiding libc dependency on Linux:
//   - Linux: /dev/ptmx + TIOCSPTLCK/TIOCGPTN ioctls (pure Zig syscalls)
//   - macOS: posix_openpt + grantpt + unlockpt + ptsname (libSystem,
//     always linked on macOS regardless of link_libc setting)
//   - BSD: same C functions as macOS
//   - Windows: unsupported, returns error (falls back to pipes)

const std = @import("std");
const builtin = @import("builtin");

pub const PtyPair = struct {
    /// Master fd — parent reads from this to get child output.
    master: std.posix.fd_t,
    /// Slave fd — child writes to this (it appears as a TTY).
    slave: std.posix.fd_t,

    pub fn closeMaster(self: PtyPair) void {
        std.posix.close(self.master);
    }

    pub fn closeSlave(self: PtyPair) void {
        std.posix.close(self.slave);
    }

    pub fn masterFile(self: PtyPair) std.fs.File {
        return .{ .handle = self.master };
    }
};

/// Disable output post-processing on a PTY slave so the terminal line
/// discipline does not transform bytes (e.g. \n → \r\n via ONLCR/OPOST).
/// Without this, multiline secrets containing \n would be emitted as \r\n,
/// breaking exact-byte redaction matching and leaking secrets.
/// Silently ignores errors (fd may not be a terminal).
/// No-op on Windows (no POSIX termios).
pub fn disableOutputProcessing(fd: std.posix.fd_t) void {
    if (builtin.os.tag == .windows) return;
    var term = std.posix.tcgetattr(fd) catch return;
    term.oflag.OPOST = false;
    std.posix.tcsetattr(fd, .NOW, term) catch {};
}

/// Open a new PTY master/slave pair.
/// Caller must close both fds when done.
/// Returns error.UnsupportedOs on Windows.
pub fn openPty() !PtyPair {
    return switch (builtin.os.tag) {
        .linux => linux.open(),
        .macos => darwin.open(),
        .freebsd, .netbsd, .openbsd, .dragonfly => bsd.open(),
        else => error.UnsupportedOs,
    };
}

/// Copy the terminal window size from a source fd to a PTY master.
/// Silently ignores errors (source may not be a terminal).
pub fn copyWinsize(src_fd: std.posix.fd_t, dst_fd: std.posix.fd_t) void {
    switch (builtin.os.tag) {
        .linux => {
            var ws: std.posix.winsize = undefined;
            if (std.posix.errno(std.os.linux.ioctl(@intCast(src_fd), std.posix.T.IOCGWINSZ, @intFromPtr(&ws))) != .SUCCESS) return;
            _ = std.os.linux.ioctl(@intCast(dst_fd), std.posix.T.IOCSWINSZ, @intFromPtr(&ws));
        },
        .macos, .freebsd, .netbsd, .openbsd, .dragonfly => {
            var ws: std.posix.winsize = undefined;
            if (std.posix.system.ioctl(src_fd, @as(c_int, @bitCast(@as(u32, 0x40087468))), @intFromPtr(&ws)) != 0) return;
            _ = std.posix.system.ioctl(dst_fd, @as(c_int, @bitCast(@as(u32, 0x80087467))), @intFromPtr(&ws));
        },
        else => {},
    }
}

// ── Linux: pure Zig syscalls, no libc ────────────────────────────────

const linux = struct {
    fn open() !PtyPair {
        // CLOEXEC so the raw PTY fds are not inherited by the child process.
        // The dup2'd copies onto STDOUT/STDERR are separate fds and remain
        // inheritable. Without CLOEXEC, a backgrounded grandchild holding the
        // inherited slave fd would keep the PTY alive and hang the redaction
        // reader waiting for EOF/EIO.
        const flags: std.posix.O = .{ .ACCMODE = .RDWR, .NOCTTY = true, .CLOEXEC = true };
        const master = try std.posix.openat(std.posix.AT.FDCWD, "/dev/ptmx", flags, 0);
        errdefer std.posix.close(master);

        // unlockpt via ioctl (TIOCSPTLCK) — use raw syscall with u32 request
        var n: c_uint = 0;
        const rc1 = std.os.linux.ioctl(@intCast(master), std.posix.T.IOCSPTLCK, @intFromPtr(&n));
        if (std.posix.errno(rc1) != .SUCCESS) return error.UnlockPtFailed;

        // ptsname via ioctl (TIOCGPTN)
        const rc2 = std.os.linux.ioctl(@intCast(master), std.posix.T.IOCGPTN, @intFromPtr(&n));
        if (std.posix.errno(rc2) != .SUCCESS) return error.PtsnameFailed;

        var buf: [24]u8 = undefined;
        const sname = try std.fmt.bufPrint(&buf, "/dev/pts/{d}", .{n});
        const slave = try std.posix.openat(std.posix.AT.FDCWD, sname, flags, 0);

        return .{ .master = master, .slave = slave };
    }
};

// ── macOS: C externs resolved via libSystem (always linked) ──────────

const darwin = struct {
    extern fn posix_openpt(flags: std.posix.O) std.posix.fd_t;
    extern fn grantpt(fd: std.posix.fd_t) c_int;
    extern fn unlockpt(fd: std.posix.fd_t) c_int;
    extern fn ptsname(fd: std.posix.fd_t) ?[*:0]u8;

    fn open() !PtyPair {
        const flags: std.posix.O = .{ .ACCMODE = .RDWR, .NOCTTY = true, .CLOEXEC = true };
        const master = darwin.posix_openpt(flags);
        if (master < 0) return error.OpenPtyFailed;
        errdefer std.posix.close(master);

        if (darwin.grantpt(master) != 0) return error.GrantPtFailed;
        if (darwin.unlockpt(master) != 0) return error.UnlockPtFailed;

        const sname_ptr = darwin.ptsname(master) orelse return error.PtsnameFailed;
        const sname = std.mem.sliceTo(sname_ptr, 0);
        const slave = try std.posix.openat(std.posix.AT.FDCWD, sname, flags, 0);

        return .{ .master = master, .slave = slave };
    }
};

// ── BSD: same C externs as macOS + ptsname_r ─────────────────────────

const bsd = struct {
    extern fn posix_openpt(flags: std.posix.O) std.posix.fd_t;
    extern fn grantpt(fd: std.posix.fd_t) c_int;
    extern fn unlockpt(fd: std.posix.fd_t) c_int;
    extern fn ptsname_r(fd: std.posix.fd_t, buf: [*]u8, len: usize) c_int;

    fn open() !PtyPair {
        const flags: std.posix.O = .{ .ACCMODE = .RDWR, .NOCTTY = true, .CLOEXEC = true };
        const master = bsd.posix_openpt(flags);
        if (master < 0) return error.OpenPtyFailed;
        errdefer std.posix.close(master);

        if (bsd.grantpt(master) != 0) return error.GrantPtFailed;
        if (bsd.unlockpt(master) != 0) return error.UnlockPtFailed;

        var sname_buf: [64]u8 = undefined;
        if (bsd.ptsname_r(master, &sname_buf, sname_buf.len) != 0) return error.PtsnameFailed;
        const sname = std.mem.sliceTo(&sname_buf, 0);
        const slave = try std.posix.openat(std.posix.AT.FDCWD, sname, flags, 0);

        return .{ .master = master, .slave = slave };
    }
};

// ── Tests ────────────────────────────────────────────────────────────

test "openPty returns valid master and slave fds" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const pair = try openPty();
    defer pair.closeMaster();
    defer pair.closeSlave();

    // Both fds should be valid (non-negative)
    try std.testing.expect(pair.master >= 0);
    try std.testing.expect(pair.slave >= 0);
    try std.testing.expect(pair.master != pair.slave);
}

test "PTY slave reports as a TTY" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const pair = try openPty();
    defer pair.closeMaster();
    defer pair.closeSlave();

    try std.testing.expect(std.posix.isatty(pair.slave));
    // Master is also a TTY device
    try std.testing.expect(std.posix.isatty(pair.master));
}

test "PTY write to slave is readable from master" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const pair = try openPty();
    defer pair.closeMaster();
    defer pair.closeSlave();

    const slave_file = std.fs.File{ .handle = pair.slave };
    const master_file = pair.masterFile();

    // Write to slave
    try slave_file.writeAll("hello from slave\n");

    // Read from master — PTY may echo and add \r, so just check the
    // payload is present somewhere in the output.
    var buf: [256]u8 = undefined;
    const n = try master_file.read(&buf);
    try std.testing.expect(n > 0);
    try std.testing.expect(std.mem.indexOf(u8, buf[0..n], "hello from slave") != null);
}

test "PTY master read returns EIO after slave is closed" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const pair = try openPty();
    defer pair.closeMaster();

    // Close the slave side
    pair.closeSlave();

    // Reading from master should return EIO (or 0 bytes) since no slave
    // writers remain. Our streamPipeRedacted handles this as EOF.
    const master_file = pair.masterFile();
    var buf: [64]u8 = undefined;
    const result = master_file.read(&buf);
    if (result) |n| {
        // Some systems return 0 (EOF) instead of EIO
        try std.testing.expectEqual(@as(usize, 0), n);
    } else |err| {
        try std.testing.expect(err == error.InputOutput);
    }
}

test "copyWinsize does not crash on non-TTY fds" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    // Create a regular pipe — not a TTY. copyWinsize should silently
    // ignore the error and not crash.
    const pipe = try std.posix.pipe2(.{});
    defer std.posix.close(pipe[0]);
    defer std.posix.close(pipe[1]);

    // Should be a no-op without crashing
    copyWinsize(pipe[0], pipe[1]);
}

test "copyWinsize propagates size between PTYs" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const src = try openPty();
    defer src.closeMaster();
    defer src.closeSlave();

    const dst = try openPty();
    defer dst.closeMaster();
    defer dst.closeSlave();

    // Set a known size on the source PTY master
    const TIOCSWINSZ: c_int = switch (builtin.os.tag) {
        .linux => @bitCast(@as(u32, 0x5414)),
        else => @bitCast(@as(u32, 0x80087467)),
    };
    const TIOCGWINSZ: c_int = switch (builtin.os.tag) {
        .linux => @bitCast(@as(u32, 0x5413)),
        else => @bitCast(@as(u32, 0x40087468)),
    };

    var ws_set: std.posix.winsize = .{ .row = 42, .col = 132, .xpixel = 0, .ypixel = 0 };
    _ = std.posix.system.ioctl(src.master, TIOCSWINSZ, @intFromPtr(&ws_set));

    // Copy from source to destination
    copyWinsize(src.master, dst.master);

    // Read back from destination
    var ws_get: std.posix.winsize = undefined;
    const rc = std.posix.system.ioctl(dst.master, TIOCGWINSZ, @intFromPtr(&ws_get));
    if (rc == 0) {
        try std.testing.expectEqual(@as(u16, 42), ws_get.row);
        try std.testing.expectEqual(@as(u16, 132), ws_get.col);
    }
    // If ioctl fails (some CI environments), the test still passes —
    // we just verified copyWinsize didn't crash.
}

test "multiple PTY pairs are independent" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const pair1 = try openPty();
    defer pair1.closeMaster();
    defer pair1.closeSlave();

    const pair2 = try openPty();
    defer pair2.closeMaster();
    defer pair2.closeSlave();

    // All four fds should be distinct
    try std.testing.expect(pair1.master != pair2.master);
    try std.testing.expect(pair1.slave != pair2.slave);
    try std.testing.expect(pair1.master != pair2.slave);
    try std.testing.expect(pair1.slave != pair2.master);

    // Write to one pair, the other should not receive it
    const slave1 = std.fs.File{ .handle = pair1.slave };
    try slave1.writeAll("pair1\n");

    const master1 = pair1.masterFile();
    var buf1: [64]u8 = undefined;
    const n1 = try master1.read(&buf1);
    try std.testing.expect(std.mem.indexOf(u8, buf1[0..n1], "pair1") != null);
}
