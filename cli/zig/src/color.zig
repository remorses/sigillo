// ANSI color helpers for terminal output.
// Each function wraps text in escape codes, only emitting them when
// the file descriptor is a TTY (so piped/redirected output stays clean).

const std = @import("std");

const File = std.fs.File;
pub const Writer = File.DeprecatedWriter;

pub const reset = "\x1b[0m";
pub const bold_s = "\x1b[1m";
pub const dim_s = "\x1b[2m";
pub const red_s = "\x1b[31m";
pub const green_s = "\x1b[32m";
pub const blue_s = "\x1b[34m";
pub const cyan_s = "\x1b[36m";

pub fn isTty(writer: Writer) bool {
    const handle = writer.context.handle;
    return std.posix.isatty(handle);
}

pub fn bold(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(bold_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}

pub fn green(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(green_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}

pub fn blue(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(blue_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}

pub fn cyan(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(cyan_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}

pub fn dim(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(dim_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}

pub fn err(w: Writer, text: []const u8) !void {
    if (isTty(w)) {
        try w.writeAll(bold_s);
        try w.writeAll(red_s);
        try w.writeAll(text);
        try w.writeAll(reset);
    } else try w.writeAll(text);
}
