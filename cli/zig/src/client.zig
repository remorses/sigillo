// HTTP client for the Sigillo API.
// Centralizes JSON requests, Bearer auth, and error parsing.

const std = @import("std");

pub const ApiResult = struct {
    status: u16,
    body: []u8,
};

pub fn request(
    allocator: std.mem.Allocator,
    method: std.http.Method,
    base_url: []const u8,
    path: []const u8,
    token: ?[]const u8,
    json_body: ?[]const u8,
) !ApiResult {
    const url = try std.fmt.allocPrint(allocator, "{s}{s}", .{ base_url, path });
    defer allocator.free(url);

    var http_client: std.http.Client = .{ .allocator = allocator };
    defer http_client.deinit();

    var response_body: std.io.Writer.Allocating = .init(allocator);
    defer response_body.deinit();

    var headers: std.http.Client.Request.Headers = .{};
    if (json_body != null) {
        headers.content_type = .{ .override = "application/json" };
    }

    const result = if (token) |value| blk: {
        const auth_header = try std.fmt.allocPrint(allocator, "Bearer {s}", .{value});
        defer allocator.free(auth_header);

        const extra_headers = [_]std.http.Header{.{ .name = "authorization", .value = auth_header }};
        break :blk try http_client.fetch(.{
            .location = .{ .url = url },
            .method = method,
            .payload = json_body,
            .headers = headers,
            .extra_headers = &extra_headers,
            .response_writer = &response_body.writer,
        });
    } else try http_client.fetch(.{
        .location = .{ .url = url },
        .method = method,
        .payload = json_body,
        .headers = headers,
        .response_writer = &response_body.writer,
    });

    return .{
        .status = @intFromEnum(result.status),
        .body = try allocator.dupe(u8, response_body.written()),
    };
}

pub fn parseError(allocator: std.mem.Allocator, body: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, allocator, body, .{}) catch return null;

    const object = switch (parsed) {
        .object => |value| value,
        else => return null,
    };

    if (object.get("error_description")) |value| {
        if (value == .string) return value.string;
    }
    if (object.get("error")) |value| {
        if (value == .string) return value.string;
    }
    return null;
}

pub fn jsonString(allocator: std.mem.Allocator, body: []const u8, field: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, allocator, body, .{}) catch return null;

    const object = switch (parsed) {
        .object => |value| value,
        else => return null,
    };

    const value = object.get(field) orelse return null;
    return switch (value) {
        .string => |string| string,
        else => null,
    };
}

pub fn jsonInt(allocator: std.mem.Allocator, body: []const u8, field: []const u8) ?i64 {
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, allocator, body, .{}) catch return null;

    const object = switch (parsed) {
        .object => |value| value,
        else => return null,
    };

    const value = object.get(field) orelse return null;
    return switch (value) {
        .integer => |integer| integer,
        else => null,
    };
}
