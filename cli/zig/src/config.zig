// Scoped JSON config system for the sigillo CLI.
// Stores everything in ~/.sigillo/config.json with Doppler-style directory scopes.

const std = @import("std");

pub const ScopedEntry = struct {
    token: ?[]const u8 = null,
    api_url: ?[]const u8 = null,
    project: ?[]const u8 = null,
    environment: ?[]const u8 = null,
};

pub const ResolvedConfig = ScopedEntry;

pub const ScopeRecord = struct {
    scope: []const u8,
    entry: ScopedEntry,
};

pub const ConfigFile = struct {
    scopes: std.ArrayListUnmanaged(ScopeRecord) = .empty,

    pub fn deinit(self: *ConfigFile, allocator: std.mem.Allocator) void {
        for (self.scopes.items) |record| {
            allocator.free(record.scope);
            freeOptional(allocator, record.entry.token);
            freeOptional(allocator, record.entry.api_url);
            freeOptional(allocator, record.entry.project);
            freeOptional(allocator, record.entry.environment);
        }
        self.scopes.deinit(allocator);
        self.* = .{};
    }
};

const config_dir_name = ".sigillo";
const config_file_name = "config.json";

pub fn configFilePath(allocator: std.mem.Allocator) ![]const u8 {
    const home = std.posix.getenv("HOME") orelse std.posix.getenv("USERPROFILE") orelse return error.NoHomeDir;
    return std.fs.path.join(allocator, &.{ home, config_dir_name, config_file_name });
}

pub fn configDirPath(allocator: std.mem.Allocator) ![]const u8 {
    const home = std.posix.getenv("HOME") orelse std.posix.getenv("USERPROFILE") orelse return error.NoHomeDir;
    return std.fs.path.join(allocator, &.{ home, config_dir_name });
}

pub fn readConfig(allocator: std.mem.Allocator) !ConfigFile {
    const path = try configFilePath(allocator);
    defer allocator.free(path);

    const file = std.fs.openFileAbsolute(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return err,
    };
    defer file.close();

    const bytes = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(bytes);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch return .{};
    defer parsed.deinit();

    var config: ConfigFile = .{};
    const root = switch (parsed.value) {
        .object => |obj| obj,
        else => return config,
    };

    const scoped_value = root.get("scoped") orelse return config;
    const scoped_object = switch (scoped_value) {
        .object => |obj| obj,
        else => return config,
    };

    var iter = scoped_object.iterator();
    while (iter.next()) |entry| {
        const scope_value = entry.value_ptr.*;
        const scope_object = switch (scope_value) {
            .object => |obj| obj,
            else => continue,
        };

        const scope = try allocator.dupe(u8, entry.key_ptr.*);
        var record: ScopeRecord = .{
            .scope = scope,
            .entry = .{},
        };

        if (scope_object.get("token")) |value| {
            if (value == .string) record.entry.token = try allocator.dupe(u8, value.string);
        }
        if (scope_object.get("api-url")) |value| {
            if (value == .string) record.entry.api_url = try allocator.dupe(u8, value.string);
        }
        if (scope_object.get("project")) |value| {
            if (value == .string) record.entry.project = try allocator.dupe(u8, value.string);
        }
        if (scope_object.get("environment")) |value| {
            if (value == .string) record.entry.environment = try allocator.dupe(u8, value.string);
        }

        try config.scopes.append(allocator, record);
    }

    return config;
}

pub fn writeConfig(allocator: std.mem.Allocator, config: *const ConfigFile) !void {
    const dir_path = try configDirPath(allocator);
    defer allocator.free(dir_path);
    const file_path = try configFilePath(allocator);
    defer allocator.free(file_path);

    std.fs.makeDirAbsolute(dir_path) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };

    var out: std.io.Writer.Allocating = .init(allocator);
    defer out.deinit();

    var json_writer: std.json.Stringify = .{
        .writer = &out.writer,
        .options = .{ .whitespace = .indent_2 },
    };

    try json_writer.beginObject();
    try json_writer.objectField("scoped");
    try json_writer.beginObject();
    for (config.scopes.items) |record| {
        try json_writer.objectField(record.scope);
        try json_writer.beginObject();
        if (record.entry.token) |value| {
            try json_writer.objectField("token");
            try json_writer.write(value);
        }
        if (record.entry.api_url) |value| {
            try json_writer.objectField("api-url");
            try json_writer.write(value);
        }
        if (record.entry.project) |value| {
            try json_writer.objectField("project");
            try json_writer.write(value);
        }
        if (record.entry.environment) |value| {
            try json_writer.objectField("environment");
            try json_writer.write(value);
        }
        try json_writer.endObject();
    }
    try json_writer.endObject();
    try json_writer.endObject();
    try out.writer.writeByte('\n');

    const file = try std.fs.createFileAbsolute(file_path, .{ .truncate = true, .read = false, .mode = 0o600 });
    defer file.close();

    var file_writer = file.writer(&.{});
    try file_writer.interface.writeAll(out.written());
    try file_writer.interface.flush();
}

pub fn setScope(allocator: std.mem.Allocator, scope_input: []const u8, updates: ScopedEntry) !void {
    var config = try readConfig(allocator);
    defer config.deinit(allocator);

    const normalized_scope = try normalizeScope(allocator, scope_input);
    defer allocator.free(normalized_scope);

    for (config.scopes.items) |*record| {
        if (!std.mem.eql(u8, record.scope, normalized_scope)) continue;
        try mergeEntry(allocator, &record.entry, updates);
        try writeConfig(allocator, &config);
        return;
    }

    var entry: ScopedEntry = .{};
    try mergeEntry(allocator, &entry, updates);
    try config.scopes.append(allocator, .{
        .scope = try allocator.dupe(u8, normalized_scope),
        .entry = entry,
    });
    try writeConfig(allocator, &config);
}

pub fn clearScope(allocator: std.mem.Allocator, scope_input: []const u8) !void {
    var config = try readConfig(allocator);
    defer config.deinit(allocator);

    const normalized_scope = try normalizeScope(allocator, scope_input);
    defer allocator.free(normalized_scope);

    var index: usize = 0;
    while (index < config.scopes.items.len) : (index += 1) {
        if (!std.mem.eql(u8, config.scopes.items[index].scope, normalized_scope)) continue;

        const removed = config.scopes.swapRemove(index);
        allocator.free(removed.scope);
        freeOptional(allocator, removed.entry.token);
        freeOptional(allocator, removed.entry.api_url);
        freeOptional(allocator, removed.entry.project);
        freeOptional(allocator, removed.entry.environment);
        break;
    }

    try writeConfig(allocator, &config);
}

pub fn resolve(allocator: std.mem.Allocator, cwd_input: []const u8, flags: ResolvedConfig) !ResolvedConfig {
    var config = try readConfig(allocator);
    defer config.deinit(allocator);

    const cwd = try normalizeScope(allocator, cwd_input);
    defer allocator.free(cwd);

    var result: ResolvedConfig = .{};
    var best_token_len: usize = 0;
    var best_api_url_len: usize = 0;
    var best_project_len: usize = 0;
    var best_environment_len: usize = 0;

    for (config.scopes.items) |record| {
        if (!scopeMatches(cwd, record.scope)) continue;

        if (record.entry.token != null and record.scope.len >= best_token_len) {
            result.token = record.entry.token;
            best_token_len = record.scope.len;
        }
        if (record.entry.api_url != null and record.scope.len >= best_api_url_len) {
            result.api_url = record.entry.api_url;
            best_api_url_len = record.scope.len;
        }
        if (record.entry.project != null and record.scope.len >= best_project_len) {
            result.project = record.entry.project;
            best_project_len = record.scope.len;
        }
        if (record.entry.environment != null and record.scope.len >= best_environment_len) {
            result.environment = record.entry.environment;
            best_environment_len = record.scope.len;
        }
    }

    if (std.posix.getenv("SIGILLO_TOKEN")) |value| result.token = value;
    if (std.posix.getenv("SIGILLO_API_URL")) |value| result.api_url = value;
    if (std.posix.getenv("SIGILLO_PROJECT")) |value| result.project = value;
    if (std.posix.getenv("SIGILLO_ENVIRONMENT")) |value| result.environment = value;

    if (flags.token) |value| result.token = value;
    if (flags.api_url) |value| result.api_url = value;
    if (flags.project) |value| result.project = value;
    if (flags.environment) |value| result.environment = value;

    return .{
        .token = if (result.token) |value| try allocator.dupe(u8, value) else null,
        .api_url = if (result.api_url) |value| try allocator.dupe(u8, value) else null,
        .project = if (result.project) |value| try allocator.dupe(u8, value) else null,
        .environment = if (result.environment) |value| try allocator.dupe(u8, value) else null,
    };
}

pub fn getCwd(allocator: std.mem.Allocator) ![]const u8 {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = try std.process.getCwd(&buffer);
    return allocator.dupe(u8, cwd);
}

fn normalizeScope(allocator: std.mem.Allocator, scope_input: []const u8) ![]const u8 {
    if (std.mem.eql(u8, scope_input, "/")) {
        return allocator.dupe(u8, "/");
    }

    const absolute = if (std.fs.path.isAbsolute(scope_input))
        try allocator.dupe(u8, scope_input)
    else blk: {
        const cwd = try getCwd(allocator);
        defer allocator.free(cwd);
        break :blk try std.fs.path.join(allocator, &.{ cwd, scope_input });
    };
    defer allocator.free(absolute);

    return std.fs.path.resolve(allocator, &.{absolute});
}

fn scopeMatches(cwd: []const u8, scope: []const u8) bool {
    if (std.mem.eql(u8, scope, "/")) return true;
    if (!std.mem.startsWith(u8, cwd, scope)) return false;
    if (cwd.len == scope.len) return true;
    return cwd[scope.len] == std.fs.path.sep;
}

fn mergeEntry(allocator: std.mem.Allocator, destination: *ScopedEntry, updates: ScopedEntry) !void {
    if (updates.token) |value| {
        freeOptional(allocator, destination.token);
        destination.token = try allocator.dupe(u8, value);
    }
    if (updates.api_url) |value| {
        freeOptional(allocator, destination.api_url);
        destination.api_url = try allocator.dupe(u8, value);
    }
    if (updates.project) |value| {
        freeOptional(allocator, destination.project);
        destination.project = try allocator.dupe(u8, value);
    }
    if (updates.environment) |value| {
        freeOptional(allocator, destination.environment);
        destination.environment = try allocator.dupe(u8, value);
    }
}

fn freeOptional(allocator: std.mem.Allocator, value: ?[]const u8) void {
    if (value) |slice| allocator.free(slice);
}

test "resolve prefers the longest matching scope" {
    var config_file: ConfigFile = .{};
    defer config_file.deinit(std.testing.allocator);

    try config_file.scopes.append(std.testing.allocator, .{
        .scope = try std.testing.allocator.dupe(u8, "/"),
        .entry = .{ .token = try std.testing.allocator.dupe(u8, "global") },
    });
    try config_file.scopes.append(std.testing.allocator, .{
        .scope = try std.testing.allocator.dupe(u8, "/tmp/project"),
        .entry = .{ .project = try std.testing.allocator.dupe(u8, "project") },
    });

    const cwd = "/tmp/project/subdir";
    var resolved: ResolvedConfig = .{};
    var best_token_len: usize = 0;
    var best_project_len: usize = 0;
    for (config_file.scopes.items) |record| {
        if (!scopeMatches(cwd, record.scope)) continue;
        if (record.entry.token != null and record.scope.len >= best_token_len) {
            resolved.token = record.entry.token;
            best_token_len = record.scope.len;
        }
        if (record.entry.project != null and record.scope.len >= best_project_len) {
            resolved.project = record.entry.project;
            best_project_len = record.scope.len;
        }
    }

    try std.testing.expectEqualStrings("global", resolved.token.?);
    try std.testing.expectEqualStrings("project", resolved.project.?);
}
