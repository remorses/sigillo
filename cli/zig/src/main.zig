// Sigillo CLI.
// Minimal Doppler-like commands for self-hosted secret access.

const std = @import("std");
const builtin = @import("builtin");
const zeke = @import("zeke");
const config = @import("config.zig");
const client = @import("client.zig");

const File = std.fs.File;
const Writer = File.DeprecatedWriter;

fn getStdout() Writer {
    return File.stdout().deprecatedWriter();
}

fn getStderr() Writer {
    return File.stderr().deprecatedWriter();
}

const Login = zeke.cmd("login", "Authenticate to Sigillo with device flow")
    .option("--api-url [url]", "Base URL of the Sigillo API")
    .option("--scope [scope]", "Directory scope for saved auth (default: /)")
    .example("sigillo login --api-url https://secrets.example.com")
    .example("sigillo login --api-url https://secrets.example.com --scope /Users/me/project");

const Logout = zeke.cmd("logout", "Remove saved auth for a scope")
    .option("--scope [scope]", "Directory scope to clear (default: /)")
    .option("--yes", "Proceed without confirmation");

const Me = zeke.cmd("me", "Show current user info")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override")
    .option("--json", "Print raw JSON");

const Setup = zeke.cmd("setup", "Save project and environment for the current directory")
    .option("--project [id]", "Project ID")
    .option("--environment [id]", "Environment ID")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override")
    .example("sigillo setup --project proj_123 --environment env_123");

const Run = zeke.cmd("run <...cmd>", "Run a command with secrets injected")
    .option("--command [cmd]", "Run a shell command string")
    .option("--project [id]", "Project ID override")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override")
    .example("sigillo run -- env")
    .example("sigillo run --command 'echo $MY_SECRET'");

fn loginAction(_: Login.Args, opts: Login.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const scope = opts.scope orelse "/";

    const cwd = config.getCwd(allocator) catch try allocator.dupe(u8, "/");

    const resolved = try config.resolve(allocator, cwd, .{
        .api_url = opts.api_url,
    });

    const api_url = resolved.api_url orelse {
        try stderr.print("error: --api-url is required\n", .{});
        try stderr.print("  sigillo login --api-url https://your-instance.example.com\n", .{});
        std.process.exit(1);
    };

    const code_res = client.request(
        allocator,
        .POST,
        api_url,
        "/api/auth/device/code",
        null,
        "{\"client_id\":\"sigillo-cli\"}",
    ) catch |err| {
        try stderr.print("error: failed to request device code: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    if (code_res.status != 200) {
        const message = client.parseError(allocator, code_res.body) orelse try allocator.dupe(u8, "unknown error");
        try stderr.print("error: device code request failed ({d}): {s}\n", .{ code_res.status, message });
        std.process.exit(1);
    }

    const device_code = client.jsonString(allocator, code_res.body, "device_code") orelse {
        try stderr.print("error: device code response missing device_code\n", .{});
        std.process.exit(1);
    };
    const user_code = client.jsonString(allocator, code_res.body, "user_code") orelse {
        try stderr.print("error: device code response missing user_code\n", .{});
        std.process.exit(1);
    };
    const verification_uri = client.jsonString(allocator, code_res.body, "verification_uri_complete") orelse blk: {
        const fallback = client.jsonString(allocator, code_res.body, "verification_uri") orelse {
            try stderr.print("error: device code response missing verification URI\n", .{});
            std.process.exit(1);
        };
        break :blk fallback;
    };
    const interval_seconds = client.jsonInt(allocator, code_res.body, "interval") orelse 5;

    try stdout.print("Open this URL in your browser:\n  {s}\n\n", .{verification_uri});
    try stdout.print("Code: {s}\n", .{user_code});
    try stdout.print("Waiting for approval...\n", .{});

    openBrowser(allocator, verification_uri);

    const poll_body = try std.fmt.allocPrint(
        allocator,
        "{{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"{s}\",\"client_id\":\"sigillo-cli\"}}",
        .{device_code},
    );
    var sleep_seconds: u64 = @intCast(interval_seconds);
    var attempts: usize = 0;
    while (attempts < 120) : (attempts += 1) {
        std.Thread.sleep(sleep_seconds * std.time.ns_per_s);

        const token_res = client.request(
            allocator,
            .POST,
            api_url,
            "/api/auth/device/token",
            null,
            poll_body,
        ) catch continue;
        if (token_res.status == 200) {
            const access_token = client.jsonString(allocator, token_res.body, "access_token") orelse {
                try stderr.print("error: token response missing access_token\n", .{});
                std.process.exit(1);
            };
            try config.setScope(allocator, scope, .{
                .token = access_token,
                .api_url = api_url,
            });

            try stdout.print("Logged in successfully\n", .{});
            return;
        }

        const error_code = client.jsonString(allocator, token_res.body, "error") orelse {
            continue;
        };
        if (std.mem.eql(u8, error_code, "authorization_pending")) continue;
        if (std.mem.eql(u8, error_code, "slow_down")) {
            sleep_seconds += 5;
            continue;
        }
        if (std.mem.eql(u8, error_code, "expired_token")) {
            try stderr.print("error: device code expired. Run login again.\n", .{});
            std.process.exit(1);
        }
        if (std.mem.eql(u8, error_code, "access_denied")) {
            try stderr.print("error: login was denied\n", .{});
            std.process.exit(1);
        }

        const message = client.parseError(allocator, token_res.body) orelse error_code;
        try stderr.print("error: {s}\n", .{message});
        std.process.exit(1);
    }

    try stderr.print("error: login timed out\n", .{});
    std.process.exit(1);
}

fn logoutAction(_: Logout.Args, opts: Logout.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    if (!opts.yes) {
        try stderr.print("error: pass --yes to confirm logout\n", .{});
        try stderr.print("  sigillo logout --yes\n", .{});
        std.process.exit(1);
    }

    const scope = opts.scope orelse "/";
    try config.clearScope(allocator, scope);
    try stdout.print("Logged out from scope {s}\n", .{scope});
}

fn meAction(_: Me.Args, opts: Me.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const cwd = try config.getCwd(allocator);

    const resolved = try config.resolve(allocator, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
    });

    const token = resolved.token orelse {
        try stderr.print("error: not logged in\n", .{});
        try stderr.print("  sigillo login --api-url https://your-instance.example.com\n", .{});
        std.process.exit(1);
    };
    const api_url = resolved.api_url orelse {
        try stderr.print("error: no API URL configured\n", .{});
        try stderr.print("  sigillo login --api-url https://your-instance.example.com\n", .{});
        std.process.exit(1);
    };

    const res = client.request(allocator, .GET, api_url, "/api/me", token, null) catch |err| {
        try stderr.print("error: failed to fetch /api/me: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try stderr.print("error: /api/me failed ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    if (opts.json) {
        try stdout.print("{s}\n", .{res.body});
        return;
    }

    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, res.body, .{});

    const root = switch (parsed) {
        .object => |value| value,
        else => {
            try stdout.print("{s}\n", .{res.body});
            return;
        },
    };

    const user = root.get("user") orelse {
        try stdout.print("{s}\n", .{res.body});
        return;
    };
    if (user == .object) {
        const user_obj = user.object;
        const name = if (user_obj.get("name")) |value| switch (value) { .string => |s| s, else => "—" } else "—";
        const email = if (user_obj.get("email")) |value| switch (value) { .string => |s| s, else => "—" } else "—";
        try stdout.print("User:  {s}\n", .{name});
        try stdout.print("Email: {s}\n", .{email});
    }

    if (root.get("orgs")) |orgs| {
        if (orgs == .array and orgs.array.items.len > 0) {
            try stdout.print("\nOrganizations:\n", .{});
            for (orgs.array.items) |org| {
                if (org != .object) continue;
                const org_obj = org.object;
                const id = if (org_obj.get("id")) |value| switch (value) { .string => |s| s, else => "—" } else "—";
                const name = if (org_obj.get("name")) |value| switch (value) { .string => |s| s, else => "—" } else "—";
                const role = if (org_obj.get("role")) |value| switch (value) { .string => |s| s, else => "—" } else "—";
                try stdout.print("  {s}  {s}  ({s})\n", .{ id, name, role });
            }
        }
    }
}

fn setupAction(_: Setup.Args, opts: Setup.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const cwd = try config.getCwd(allocator);

    const resolved = try config.resolve(allocator, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
    });

    const token = resolved.token orelse {
        try stderr.print("error: not logged in\n", .{});
        try stderr.print("  sigillo login --api-url https://your-instance.example.com\n", .{});
        std.process.exit(1);
    };
    const api_url = resolved.api_url orelse {
        try stderr.print("error: no API URL configured\n", .{});
        std.process.exit(1);
    };

    const project = opts.project orelse {
        try stderr.print("error: --project is required\n", .{});
        try stderr.print("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n", .{});
        std.process.exit(1);
    };

    const environment = opts.environment orelse {
        try stderr.print("error: --environment is required\n", .{});
        try stderr.print("  sigillo setup --project {s} --environment <ENVIRONMENT_ID>\n", .{project});
        std.process.exit(1);
    };

    const path = try std.fmt.allocPrint(allocator, "/api/projects/{s}/environments", .{project});
    const res = client.request(allocator, .GET, api_url, path, token, null) catch |err| {
        try stderr.print("error: failed to validate project: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try stderr.print("error: failed to validate project ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    var found_environment = false;
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, res.body, .{});
    if (parsed == .object) {
        if (parsed.object.get("environments")) |environments_value| {
            if (environments_value == .array) {
                for (environments_value.array.items) |item| {
                    if (item != .object) continue;
                    const id_value = item.object.get("id") orelse continue;
                    if (id_value != .string) continue;
                    if (std.mem.eql(u8, id_value.string, environment)) {
                        found_environment = true;
                        break;
                    }
                }
            }
        }
    }

    if (!found_environment) {
        try stderr.print("error: environment {s} not found in project {s}\n", .{ environment, project });
        std.process.exit(1);
    }

    try config.setScope(allocator, cwd, .{
        .project = project,
        .environment = environment,
    });

    try stdout.print("Saved setup for {s}\n", .{cwd});
    try stdout.print("  project:     {s}\n", .{project});
    try stdout.print("  environment: {s}\n", .{environment});
}

fn runAction(args: Run.Args, opts: Run.Options) !void {
    const stderr = getStderr();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const use_shell = opts.command != null;
    if (use_shell and args.cmd.len > 0) {
        try stderr.print("error: use either --command or positional args, not both\n", .{});
        std.process.exit(1);
    }
    if (!use_shell and args.cmd.len == 0) {
        try stderr.print("error: command is required\n", .{});
        try stderr.print("  sigillo run -- env\n", .{});
        try stderr.print("  sigillo run --command 'echo $MY_SECRET'\n", .{});
        std.process.exit(1);
    }

    const cwd = try config.getCwd(allocator);

    const resolved = try config.resolve(allocator, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .project = opts.project,
        .environment = opts.environment,
    });

    const token = resolved.token orelse {
        try stderr.print("error: not logged in\n", .{});
        try stderr.print("  sigillo login --api-url https://your-instance.example.com\n", .{});
        std.process.exit(1);
    };
    const api_url = resolved.api_url orelse {
        try stderr.print("error: no API URL configured\n", .{});
        std.process.exit(1);
    };
    _ = resolved.project;
    const environment = resolved.environment orelse {
        try stderr.print("error: environment not configured\n", .{});
        try stderr.print("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n", .{});
        std.process.exit(1);
    };

    const path = try std.fmt.allocPrint(allocator, "/api/environments/{s}/secrets/download?format=json", .{environment});
    const res = client.request(allocator, .GET, api_url, path, token, null) catch |err| {
        try stderr.print("error: failed to fetch secrets: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try stderr.print("error: failed to fetch secrets ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, res.body, .{});
    const secrets = switch (parsed) {
        .object => |value| value,
        else => {
            try stderr.print("error: invalid secrets response\n", .{});
            std.process.exit(1);
        },
    };

    const final_command = if (use_shell)
        try prependSecretsToShellCommand(allocator, opts.command.?, secrets)
    else blk: {
        const positional_command = try shellJoinArgs(allocator, args.cmd);
        break :blk try prependSecretsToShellCommand(allocator, positional_command, secrets);
    };

    const argv: []const []const u8 = switch (builtin.os.tag) {
        .windows => &.{ "cmd.exe", "/C", final_command },
        else => &.{ "/bin/sh", "-c", final_command },
    };

    var child = std.process.Child.init(argv, gpa.allocator());
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;

    try child.spawn();
    const term = try child.wait();
    switch (term) {
        .Exited => |code| std.process.exit(code),
        else => std.process.exit(1),
    }
}

fn prependSecretsToShellCommand(allocator: std.mem.Allocator, command: []const u8, secrets: std.json.ObjectMap) ![]const u8 {
    var out: std.io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    if (builtin.os.tag == .windows) {
        var iter = secrets.iterator();
        while (iter.next()) |entry| {
            if (entry.value_ptr.* != .string) continue;
            try out.writer.print("set \"{s}={s}\" && ", .{ entry.key_ptr.*, entry.value_ptr.*.string });
        }
        try out.writer.writeAll(command);
        return allocator.dupe(u8, out.written());
    }

    var iter = secrets.iterator();
    while (iter.next()) |entry| {
        if (entry.value_ptr.* != .string) continue;
        try out.writer.print("export {s}=", .{entry.key_ptr.*});
        try writePosixSingleQuoted(&out.writer, entry.value_ptr.*.string);
        try out.writer.writeAll("; ");
    }
    try out.writer.writeAll(command);
    return allocator.dupe(u8, out.written());
}

fn shellJoinArgs(allocator: std.mem.Allocator, args: []const []const u8) ![]const u8 {
    var out = std.ArrayListUnmanaged(u8).empty;
    errdefer out.deinit(allocator);

    if (builtin.os.tag == .windows) {
        for (args, 0..) |arg, index| {
            if (index > 0) try out.append(allocator, ' ');
            try out.append(allocator, '"');
            try out.appendSlice(allocator, arg);
            try out.append(allocator, '"');
        }
        return out.toOwnedSlice(allocator);
    }

    for (args, 0..) |arg, index| {
        if (index > 0) try out.append(allocator, ' ');
        try out.append(allocator, '\'');
        for (arg) |char| {
            if (char == '\'') {
                try out.appendSlice(allocator, "'\"'\"'");
            } else {
                try out.append(allocator, char);
            }
        }
        try out.append(allocator, '\'');
    }
    return out.toOwnedSlice(allocator);
}

fn writePosixSingleQuoted(writer: *std.Io.Writer, value: []const u8) !void {
    try writer.writeByte('\'');
    for (value) |char| {
        if (char == '\'') {
            try writer.writeAll("'\"'\"'");
        } else {
            try writer.writeByte(char);
        }
    }
    try writer.writeByte('\'');
}

fn openBrowser(allocator: std.mem.Allocator, url: []const u8) void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .macos => &.{ "open", url },
        .windows => &.{ "cmd.exe", "/C", "start", url },
        else => &.{ "xdg-open", url },
    };

    var child = std.process.Child.init(argv, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    child.spawn() catch return;
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    var app = zeke.App(.{
        Login.bind(loginAction),
        Logout.bind(logoutAction),
        Me.bind(meAction),
        Setup.bind(setupAction),
        Run.bind(runAction),
    }).init(allocator, "sigillo");

    const build_options = @import("build_options");
    app.setVersion(build_options.version);

    var arg_iter = try std.process.argsWithAllocator(allocator);
    defer arg_iter.deinit();

    var argv = std.ArrayListUnmanaged([]const u8).empty;
    defer argv.deinit(allocator);

    _ = arg_iter.next();
    while (arg_iter.next()) |arg| {
        try argv.append(allocator, arg);
    }

    if (argv.items.len >= 2 and std.mem.eql(u8, argv.items[0], "run") and std.mem.eql(u8, argv.items[1], "--")) {
        _ = argv.orderedRemove(1);
    }

    // Keep positional `sigillo run env` working by rewriting it to the
    // already-working `--command` form before zeke parses it. This stays simple
    // and avoids custom arg parsing inside the action.
    if (
        argv.items.len >= 2 and
        std.mem.eql(u8, argv.items[0], "run") and
        !std.mem.startsWith(u8, argv.items[1], "-")
    ) {
        const joined = try shellJoinArgs(allocator, argv.items[1..]);
        argv.items.len = 0;
        try argv.append(allocator, "run");
        try argv.append(allocator, "--command");
        try argv.append(allocator, joined);
    }

    app.dispatch(argv.items) catch |err| {
        const stderr = getStderr();
        stderr.print("error: {s}\n", .{@errorName(err)}) catch {};
        std.process.exit(1);
    };
}
