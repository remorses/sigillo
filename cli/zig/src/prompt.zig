// Interactive terminal prompts for the sigillo CLI.
// Implements select/option picker with arrow-key navigation.
// Based on zig-prompter's approach but uses POSIX termios directly
// (no mibu dependency) so it cross-compiles to all targets.
// Falls back to numbered list input when stdin is not a TTY.

const std = @import("std");
const builtin = @import("builtin");
const color = @import("color.zig");

const posix = std.posix;

const Key = union(enum) {
    up,
    down,
    enter,
    abort, // ctrl-c / ctrl-d
    char: u8,
    unknown,
};

/// Read a single keypress from raw-mode stdin.
/// Handles escape sequences for arrow keys.
fn readKey(stdin: std.fs.File) !Key {
    var buf: [1]u8 = undefined;
    const n = try stdin.read(&buf);
    if (n == 0) return .abort;

    return switch (buf[0]) {
        3, 4 => .abort, // ctrl-c, ctrl-d
        '\r', '\n' => .enter,
        'j' => .down,
        'k' => .up,
        '\x1b' => blk: {
            // Escape sequence — read [A / [B for arrows
            var seq: [2]u8 = undefined;
            const n2 = try stdin.read(&seq);
            if (n2 < 2) break :blk Key.unknown;
            if (seq[0] != '[') break :blk Key.unknown;
            break :blk switch (seq[1]) {
                'A' => Key.up,
                'B' => Key.down,
                else => Key.unknown,
            };
        },
        else => .{ .char = buf[0] },
    };
}

/// Show an interactive select prompt. Returns the selected index, or null if aborted.
/// `prompt_text` is shown above the options. `options` is the list of display strings.
/// `default` is the initially highlighted index (0 if null).
///
/// When stdin is not a TTY (piped input, CI, Windows without console), falls back
/// to printing a numbered list and reading a number from stdin.
pub fn select(prompt_text: []const u8, options: []const []const u8, default: ?usize) !?usize {
    if (options.len == 0) return null;

    const stdin = std.io.getStdIn();
    const stdout = std.io.getStdOut();
    const out = stdout.deprecatedWriter();

    // Non-TTY fallback: print numbered list, read a number
    if (!posix.isatty(stdin.handle) or !posix.isatty(stdout.handle)) {
        return selectFallback(prompt_text, options, default);
    }

    // Enable raw mode via termios (POSIX only, skip on Windows)
    if (comptime builtin.os.tag == .windows) {
        return selectFallback(prompt_text, options, default);
    }

    const original_termios = try posix.tcgetattr(stdin.handle);
    var raw = original_termios;

    // Disable canonical mode, echo, signals, extended input processing
    raw.lflag.ECHO = false;
    raw.lflag.ICANON = false;
    raw.lflag.ISIG = false;
    raw.lflag.IEXTEN = false;
    // Disable software flow control and CR→NL translation
    raw.iflag.IXON = false;
    raw.iflag.ICRNL = false;
    // Read returns after 1 byte, no timeout
    raw.cc[@intFromEnum(posix.V.MIN)] = 1;
    raw.cc[@intFromEnum(posix.V.TIME)] = 0;

    try posix.tcsetattr(stdin.handle, .FLUSH, raw);
    defer posix.tcsetattr(stdin.handle, .FLUSH, original_termios) catch {};

    var selected: usize = default orelse 0;
    if (selected >= options.len) selected = 0;

    // Print prompt
    try color.blue(out, "? ");
    try color.bold(out, prompt_text);
    try out.writeAll("\n");

    // Hide cursor
    try out.writeAll("\x1b[?25l");
    defer {
        // Show cursor on exit
        out.writeAll("\x1b[?25h") catch {};
    }

    // Initial render
    try renderOptions(out, options, selected);

    while (true) {
        const key = readKey(stdin) catch break;
        switch (key) {
            .abort => {
                // Move past options, clear, show cursor
                try clearOptions(out, options.len);
                // Also clear the prompt line
                try out.writeAll("\x1b[1A"); // up to prompt
                try out.writeAll("\x1b[2K"); // clear it
                return null;
            },
            .up => {
                if (selected > 0) selected -= 1;
                try moveToOptionsStart(out, options.len);
                try renderOptions(out, options, selected);
            },
            .down => {
                if (selected < options.len - 1) selected += 1;
                try moveToOptionsStart(out, options.len);
                try renderOptions(out, options, selected);
            },
            .enter => {
                // Clear the options, rewrite the prompt with the selected value
                try clearOptions(out, options.len);
                // Go back up to the prompt line and rewrite it
                try out.writeAll("\x1b[1A"); // up to prompt
                try out.writeAll("\x1b[2K\r"); // clear line
                try color.green(out, "✔ ");
                try color.bold(out, prompt_text);
                try out.writeAll(" ");
                try color.cyan(out, options[selected]);
                try out.writeAll("\n");
                return selected;
            },
            else => {},
        }
    }

    return null;
}

fn renderOptions(out: color.Writer, options: []const []const u8, selected: usize) !void {
    for (options, 0..) |opt, i| {
        try out.writeAll("\x1b[2K\r"); // clear line
        if (i == selected) {
            try color.cyan(out, "  ❯ ");
            try color.bold(out, opt);
        } else {
            try color.dim(out, "    ");
            try out.writeAll(opt);
        }
        try out.writeAll("\n");
    }
}

fn moveToOptionsStart(out: color.Writer, count: usize) !void {
    // Move cursor up by `count` lines
    var buf: [16]u8 = undefined;
    const seq = std.fmt.bufPrint(&buf, "\x1b[{d}A", .{count}) catch return;
    try out.writeAll(seq);
}

fn clearOptions(out: color.Writer, count: usize) !void {
    try moveToOptionsStart(out, count);
    for (0..count) |_| {
        try out.writeAll("\x1b[2K\n"); // clear each line
    }
    try moveToOptionsStart(out, count);
}

/// Non-interactive fallback: print numbered list, read a number.
fn selectFallback(prompt_text: []const u8, options: []const []const u8, default: ?usize) !?usize {
    const stdout = std.io.getStdOut();
    const stdin = std.io.getStdIn();
    const out = stdout.deprecatedWriter();

    try out.writeAll(prompt_text);
    try out.writeAll(":\n");
    for (options, 0..) |opt, i| {
        const marker: []const u8 = if (default != null and i == default.?) " (default)" else "";
        try out.print("  {d}) {s}{s}\n", .{ i + 1, opt, marker });
    }
    try out.writeAll("Enter number: ");

    var buf: [32]u8 = undefined;
    const n = try stdin.read(&buf);
    if (n == 0) return default;

    const input = std.mem.trimRight(u8, buf[0..n], &std.ascii.whitespace);
    if (input.len == 0) return default;

    const num = std.fmt.parseInt(usize, input, 10) catch return default;
    if (num < 1 or num > options.len) return default;
    return num - 1;
}
