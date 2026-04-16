// Typed HTTP client for the Sigillo API used by the Zig CLI.

const std = @import("std");
pub const api = @import("generated/sigillo-api.zig");

pub const ApiResult = struct {
    status: u16,
    body: []u8,
};

pub fn JsonResult(comptime T: type) type {
    return struct {
        status: u16,
        body: []u8,
        value: ?T,
    };
}

pub const RequestArgs = struct {
    allocator: std.mem.Allocator,
    method: std.http.Method,
    base_url: []const u8,
    path: []const u8,
    token: ?[]const u8,
    json_body: ?[]const u8 = null,
    accept: []const u8 = "application/json",
};

pub fn request(args: RequestArgs) !ApiResult {
    const url = try std.fmt.allocPrint(args.allocator, "{s}{s}", .{ args.base_url, args.path });
    defer args.allocator.free(url);

    var http_client: std.http.Client = .{ .allocator = args.allocator };
    defer http_client.deinit();

    var response_body: std.io.Writer.Allocating = .init(args.allocator);
    defer response_body.deinit();

    const accept_header = [_]std.http.Header{.{ .name = "accept", .value = args.accept }};
    var headers: std.http.Client.Request.Headers = .{};
    if (args.json_body != null) {
        headers.content_type = .{ .override = "application/json" };
    }

    const result = if (args.token) |value| blk: {
        const auth_header = try std.fmt.allocPrint(args.allocator, "Bearer {s}", .{value});
        defer args.allocator.free(auth_header);

        const extra_headers = [_]std.http.Header{
            .{ .name = "authorization", .value = auth_header },
            accept_header[0],
        };
        break :blk try http_client.fetch(.{
            .location = .{ .url = url },
            .method = args.method,
            .payload = args.json_body,
            .headers = headers,
            .extra_headers = &extra_headers,
            .response_writer = &response_body.writer,
        });
    } else try http_client.fetch(.{
        .location = .{ .url = url },
        .method = args.method,
        .payload = args.json_body,
        .headers = headers,
        .extra_headers = &accept_header,
        .response_writer = &response_body.writer,
    });

    return .{
        .status = @intFromEnum(result.status),
        .body = try args.allocator.dupe(u8, response_body.written()),
    };
}

pub fn parseJsonResult(comptime T: type, args: RequestArgs) !JsonResult(T) {
    const response = try request(args);
    if (response.status < 200 or response.status >= 300) {
        return .{ .status = response.status, .body = response.body, .value = null };
    }

    return .{
        .status = response.status,
        .body = response.body,
        .value = try std.json.parseFromSliceLeaky(T, args.allocator, response.body, .{ .ignore_unknown_fields = true }),
    };
}

fn jsonBody(allocator: std.mem.Allocator, value: anytype) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{f}", .{std.json.fmt(value, .{})});
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

pub const NamedItem = struct {
    id: []const u8,
    name: []const u8,
};

pub fn jsonNamedArray(allocator: std.mem.Allocator, body: []const u8, field: []const u8) ![]NamedItem {
    var result = std.ArrayListUnmanaged(NamedItem).empty;

    const parsed = std.json.parseFromSliceLeaky(std.json.Value, allocator, body, .{}) catch return result.toOwnedSlice(allocator);
    const root = switch (parsed) {
        .object => |obj| obj,
        else => return result.toOwnedSlice(allocator),
    };
    const arr_val = root.get(field) orelse return result.toOwnedSlice(allocator);
    const arr = switch (arr_val) {
        .array => |a| a,
        else => return result.toOwnedSlice(allocator),
    };
    for (arr.items) |item| {
        const obj = switch (item) {
            .object => |o| o,
            else => continue,
        };
        const id_val = obj.get("id") orelse continue;
        const name_val = obj.get("name") orelse continue;
        const id = switch (id_val) {
            .string => |s| s,
            else => continue,
        };
        const name = switch (name_val) {
            .string => |s| s,
            else => continue,
        };
        try result.append(allocator, .{ .id = id, .name = name });
    }
    return result.toOwnedSlice(allocator);
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

pub const GetMeArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
};

pub fn getMe(args: GetMeArgs) !JsonResult(api.MeResponse) {
    return parseJsonResult(api.MeResponse, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = "/api/me",
        .token = args.token,
    });
}

pub const ListProjectsArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    org_id: []const u8,
};

pub fn listProjects(args: ListProjectsArgs) !JsonResult(api.ProjectListResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects?orgId={s}", .{args.org_id});
    return parseJsonResult(api.ProjectListResponse, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const GetProjectArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    project_id: []const u8,
};

pub fn getProject(args: GetProjectArgs) !JsonResult(api.ProjectSummary) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects/{s}", .{args.project_id});
    return parseJsonResult(api.ProjectSummary, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const CreateProjectArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    org_id: []const u8,
    name: []const u8,
};

pub fn createProject(args: CreateProjectArgs) !JsonResult(api.ProjectMutationResponse) {
    const body = try jsonBody(args.allocator, api.ProjectCreateRequest{ .orgId = args.org_id, .name = args.name });
    return parseJsonResult(api.ProjectMutationResponse, .{
        .allocator = args.allocator,
        .method = .POST,
        .base_url = args.api_url,
        .path = "/api/projects",
        .token = args.token,
        .json_body = body,
    });
}

pub const UpdateProjectArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    project_id: []const u8,
    name: []const u8,
};

pub fn updateProject(args: UpdateProjectArgs) !JsonResult(api.ProjectMutationResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects/{s}", .{args.project_id});
    const body = try jsonBody(args.allocator, api.ProjectUpdateRequest{ .name = args.name });
    return parseJsonResult(api.ProjectMutationResponse, .{
        .allocator = args.allocator,
        .method = .PATCH,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
        .json_body = body,
    });
}

pub const DeleteProjectArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    project_id: []const u8,
};

pub fn deleteProject(args: DeleteProjectArgs) !JsonResult(api.ProjectDeleteResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects/{s}", .{args.project_id});
    return parseJsonResult(api.ProjectDeleteResponse, .{
        .allocator = args.allocator,
        .method = .DELETE,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const ListEnvironmentsArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    project_id: []const u8,
};

pub fn listEnvironments(args: ListEnvironmentsArgs) !JsonResult(api.EnvironmentListResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects/{s}/environments", .{args.project_id});
    return parseJsonResult(api.EnvironmentListResponse, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const GetEnvironmentArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
};

pub fn getEnvironment(args: GetEnvironmentArgs) !JsonResult(api.EnvironmentSummary) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}", .{args.environment_id});
    return parseJsonResult(api.EnvironmentSummary, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const CreateEnvironmentArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    project_id: []const u8,
    name: []const u8,
    slug: []const u8,
};

pub fn createEnvironment(args: CreateEnvironmentArgs) !JsonResult(api.EnvironmentMutationResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/projects/{s}/environments", .{args.project_id});
    const body = try jsonBody(args.allocator, api.EnvironmentCreateRequest{ .name = args.name, .slug = args.slug });
    return parseJsonResult(api.EnvironmentMutationResponse, .{
        .allocator = args.allocator,
        .method = .POST,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
        .json_body = body,
    });
}

pub const UpdateEnvironmentArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
    name: ?[]const u8 = null,
    slug: ?[]const u8 = null,
};

pub fn updateEnvironment(args: UpdateEnvironmentArgs) !JsonResult(api.EnvironmentMutationResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}", .{args.environment_id});
    const body = try jsonBody(args.allocator, api.EnvironmentUpdateRequest{ .name = args.name, .slug = args.slug });
    return parseJsonResult(api.EnvironmentMutationResponse, .{
        .allocator = args.allocator,
        .method = .PATCH,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
        .json_body = body,
    });
}

pub const DeleteEnvironmentArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
};

pub fn deleteEnvironment(args: DeleteEnvironmentArgs) !JsonResult(api.EnvironmentDeleteResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}", .{args.environment_id});
    return parseJsonResult(api.EnvironmentDeleteResponse, .{
        .allocator = args.allocator,
        .method = .DELETE,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const ListSecretsArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
};

pub fn listSecrets(args: ListSecretsArgs) !JsonResult(api.SecretListResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}/secrets", .{args.environment_id});
    return parseJsonResult(api.SecretListResponse, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const GetSecretArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
    name: []const u8,
};

pub fn getSecret(args: GetSecretArgs) !JsonResult(api.SecretValueResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}/secrets/{s}", .{ args.environment_id, args.name });
    return parseJsonResult(api.SecretValueResponse, .{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const SetSecretArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
    name: []const u8,
    value: []const u8,
};

pub fn setSecret(args: SetSecretArgs) !JsonResult(api.SecretMutationResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}/secrets", .{args.environment_id});
    const body = try jsonBody(args.allocator, api.SecretSetRequest{ .name = args.name, .value = args.value });
    return parseJsonResult(api.SecretMutationResponse, .{
        .allocator = args.allocator,
        .method = .POST,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
        .json_body = body,
    });
}

pub const DeleteSecretArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
    name: []const u8,
};

pub fn deleteSecret(args: DeleteSecretArgs) !JsonResult(api.SecretDeleteResponse) {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}/secrets/{s}", .{ args.environment_id, args.name });
    return parseJsonResult(api.SecretDeleteResponse, .{
        .allocator = args.allocator,
        .method = .DELETE,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
    });
}

pub const DownloadSecretsArgs = struct {
    allocator: std.mem.Allocator,
    api_url: []const u8,
    token: []const u8,
    environment_id: []const u8,
};

pub fn downloadSecretsYaml(args: DownloadSecretsArgs) !ApiResult {
    const path = try std.fmt.allocPrint(args.allocator, "/api/environments/{s}/secrets/download?format=yaml", .{args.environment_id});
    return request(.{
        .allocator = args.allocator,
        .method = .GET,
        .base_url = args.api_url,
        .path = path,
        .token = args.token,
        .accept = "text/yaml",
    });
}
