// Sigillo CLI.
// Minimal Doppler-like commands for self-hosted secret access.

const std = @import("std");
const builtin = @import("builtin");
const zeke = @import("zeke");
const config = @import("config.zig");
const client = @import("client.zig");

const color = @import("color.zig");
const prompt = @import("prompt.zig");

const File = std.fs.File;
const Writer = File.DeprecatedWriter;

const supported_mount_formats = [_][]const u8{
    "env",
    "env-no-quotes",
    "json",
    "yaml",
    "docker",
    "dotnet-json",
};

const supported_download_formats = [_][]const u8{
    "json",
    "env",
    "env-no-quotes",
    "xargs",
    "yaml",
    "docker",
    "dotnet-json",
};

fn getStdout() Writer {
    return File.stdout().deprecatedWriter();
}

fn getStderr() Writer {
    return File.stderr().deprecatedWriter();
}

const Login = zeke.cmd("login", "Authenticate to Sigillo with device flow")
    .option("--token [token]", "Save an existing bearer token instead of starting device flow")
    .option("--api-url [url]", "Base URL of the Sigillo API (default: https://sigillo.dev)")
    .option("--scope [scope]", "Scope for saved auth (default: /)")
    .example("sigillo login")
    .example("SIGILLO_TOKEN=sig_xxx sigillo login --scope /")
    .example("sigillo login --token sig_xxx --scope /")
    .example("sigillo login --api-url https://sigillo.dev --scope /Users/me/project");

const Logout = zeke.cmd("logout", "Remove saved auth for a scope")
    .option("--scope [scope]", "Directory scope to clear (default: /)");

const Me = zeke.cmd("me", "Show current user info")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)")
    .option("--json", "Print raw JSON");

const Setup = zeke.cmd("setup", "Save project and environment for the current directory")
    .option("--project [id]", "Project ID")
    .option("--environment [id]", "Environment ID")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)")
    .example("sigillo setup --project proj_123 --environment env_123");

const Run = zeke.cmd("run <...cmd>", "Run a command with secrets injected")
    .option("--command [cmd]", "Run a shell command string")
    .option("--mount [path]", "Write secrets to a file before running")
    .option("--mount-format [fmt]", "Format for mounted file: env, env-no-quotes, json, yaml, docker, dotnet-json (default: env)")
    .option("--disable-redaction", "Print child output without secret redaction")
    .option("--project [id]", "Project ID override")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)")
    .example("sigillo run -- env")
    .example("sigillo run --mount .env -- npm start")
    .example("sigillo run --mount config.json --mount-format json -- next dev")
    .example("sigillo run --command 'echo $MY_SECRET'");

const Secrets = zeke.cmd("secrets", "List secrets for the configured environment")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const SecretsGet = zeke.cmd("secrets get <name>", "Get a secret value")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const SecretsSet = zeke.cmd("secrets set <name> <value>", "Set a secret value")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const SecretsDelete = zeke.cmd("secrets delete <name>", "Delete a secret")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const SecretsDownload = zeke.cmd("secrets download", "Download all secrets in a chosen format")
    .option("--format [fmt]", "Output format: json, env, env-no-quotes, xargs, yaml, docker, dotnet-json (default: yaml)")
    .option("--environment [id]", "Environment ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)")
    .example("sigillo secrets download")
    .example("sigillo secrets download --format json")
    .example("sigillo secrets download --format xargs | xargs -0 -n2 sh -c 'printf %s \"$2\" | vercel env add \"$1\" production --force' sh");

const Projects = zeke.cmd("projects", "List projects across organizations")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const ProjectsCreate = zeke.cmd("projects create", "Create a project")
    .option("--org <id>", "Organization ID")
    .option("--name <name>", "Project name")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const ProjectsGet = zeke.cmd("projects get <id>", "Get project details")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const ProjectsUpdate = zeke.cmd("projects update <id>", "Update a project")
    .option("--name <name>", "Project name")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const ProjectsDelete = zeke.cmd("projects delete <id>", "Delete a project")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const Environments = zeke.cmd("environments", "List environments for the configured project")
    .option("--project [id]", "Project ID override")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const EnvironmentsCreate = zeke.cmd("environments create", "Create an environment")
    .option("--project <id>", "Project ID")
    .option("--name <name>", "Environment name")
    .option("--slug <slug>", "Environment slug")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const EnvironmentsGet = zeke.cmd("environments get <id>", "Get environment details")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const EnvironmentsRename = zeke.cmd("environments rename <id>", "Rename an environment")
    .option("--name [name]", "Updated environment name")
    .option("--slug [slug]", "Updated environment slug")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

const EnvironmentsDelete = zeke.cmd("environments delete <id>", "Delete an environment")
    .option("--token [token]", "Auth token override")
    .option("--api-url [url]", "API URL override (default: https://sigillo.dev)");

fn loginAction(_: Login.Args, opts: Login.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const cwd = config.getCwd(allocator) catch try allocator.dupe(u8, "/");

    const scope: []const u8 = opts.scope orelse "/";

    const resolved = try config.resolve(allocator, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
    });

    const api_url = resolved.api_url.?; // always set — defaults to https://sigillo.dev

    if (resolved.token) |token| {
        try config.setScope(allocator, scope, .{
            .token = token,
            .api_url = api_url,
        });

        try color.green(stdout, "✔");
        try stdout.writeAll(" Saved bearer token\n");
        try color.dim(stdout, "Use this for CI or API-token-based secret access.\n");
        return;
    }

    const code_res = client.request(.{
        .allocator = allocator,
        .method = .POST,
        .base_url = api_url,
        .path = "/api/auth/device/code",
        .token = null,
        .json_body = "{\"client_id\":\"sigillo-cli\"}",
    }) catch |err| {
        try color.err(stderr, "error");
        try stderr.print(": failed to request device code: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    if (code_res.status != 200) {
        const message = client.parseError(allocator, code_res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": device code request failed ({d}): {s}\n", .{ code_res.status, message });
        std.process.exit(1);
    }

    const device_code = client.jsonString(allocator, code_res.body, "device_code") orelse {
        try color.err(stderr, "error");
        try stderr.print(": device code response missing device_code\n", .{});
        std.process.exit(1);
    };
    const user_code = client.jsonString(allocator, code_res.body, "user_code") orelse {
        try color.err(stderr, "error");
        try stderr.print(": device code response missing user_code\n", .{});
        std.process.exit(1);
    };
    const verification_uri = client.jsonString(allocator, code_res.body, "verification_uri_complete") orelse blk: {
        const fallback = client.jsonString(allocator, code_res.body, "verification_uri") orelse {
            try color.err(stderr, "error");
            try stderr.print(": device code response missing verification URI\n", .{});
            std.process.exit(1);
        };
        break :blk fallback;
    };
    const interval_seconds = client.jsonInt(allocator, code_res.body, "interval") orelse 5;

    try stdout.writeAll("\n");
    try color.bold(stdout, "Open this URL in your browser:\n");
    try stdout.writeAll("  ");
    try color.cyan(stdout, verification_uri);
    try stdout.writeAll("\n\n");
    try color.blue(stdout, "Code: ");
    try color.bold(stdout, user_code);
    try stdout.writeAll("\n\n");
    try color.dim(stdout, "Waiting for approval...");

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

        const token_res = client.request(.{
            .allocator = allocator,
            .method = .POST,
            .base_url = api_url,
            .path = "/api/auth/device/token",
            .token = null,
            .json_body = poll_body,
        }) catch continue;
        if (token_res.status == 200) {
            const access_token = client.jsonString(allocator, token_res.body, "access_token") orelse {
                try color.err(stderr, "error");
                try stderr.print(": token response missing access_token\n", .{});
                std.process.exit(1);
            };
            try config.setScope(allocator, scope, .{
                .token = access_token,
                .api_url = api_url,
            });

            try stdout.writeAll("\n");
            try color.green(stdout, "✔");
            try stdout.writeAll(" Logged in successfully\n");
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
            try color.err(stderr, "error");
            try stderr.print(": device code expired. Run login again.\n", .{});
            std.process.exit(1);
        }
        if (std.mem.eql(u8, error_code, "access_denied")) {
            try color.err(stderr, "error");
            try stderr.print(": login was denied\n", .{});
            std.process.exit(1);
        }

        const message = client.parseError(allocator, token_res.body) orelse error_code;
        try color.err(stderr, "error");
        try stderr.print(": {s}\n", .{message});
        std.process.exit(1);
    }

    try color.err(stderr, "error");
    try stderr.print(": login timed out\n", .{});
    std.process.exit(1);
}

fn logoutAction(_: Logout.Args, opts: Logout.Options) !void {
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();

    const scope = opts.scope orelse "/";
    try config.clearScope(allocator, scope);
    try color.green(stdout, "✔");
    try stdout.writeAll(" Logged out from scope ");
    try color.bold(stdout, scope);
    try stdout.writeAll("\n");
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
        try color.err(stderr, "error");
        try stderr.print(": not logged in\n", .{});
        try stderr.writeAll("  sigillo login\n");
        std.process.exit(1);
    };
    const api_url = resolved.api_url.?; // always set — defaults to https://sigillo.dev

    const res = client.getMe(.{
        .allocator = allocator,
        .api_url = api_url,
        .token = token,
    }) catch |err| {
        try color.err(stderr, "error");
        try stderr.print(": failed to fetch /api/me: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": /api/me failed ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    if (opts.json) {
        try stdout.print("{s}\n", .{res.body});
        return;
    }

    const me = res.value orelse {
        try stdout.print("{s}\n", .{res.body});
        return;
    };
    try color.blue(stdout, "User:  ");
    try color.bold(stdout, if (me.user.name.len > 0) me.user.name else "—");
    try stdout.writeAll("\n");
    try color.blue(stdout, "Email: ");
    try stdout.print("{s}\n", .{if (me.user.email.len > 0) me.user.email else "—"});

    if (me.orgs.len > 0) {
        try stdout.writeAll("\n");
        try color.blue(stdout, "Organizations:\n");
        for (me.orgs) |org| {
            try stdout.writeAll("  ");
            try color.bold(stdout, org.name);
            try stdout.print("  {s}  ", .{org.id});
            try color.dim(stdout, org.role);
            try stdout.writeAll("\n");
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
        try color.err(stderr, "error");
        try stderr.print(": not logged in\n", .{});
        try stderr.writeAll("  sigillo login\n");
        std.process.exit(1);
    };
    const api_url = resolved.api_url.?; // always set — defaults to https://sigillo.dev

    const is_tty = std.posix.isatty(File.stdin().handle) and
        std.posix.isatty(File.stdout().handle);

    // ── Resolve project ────────────────────────────────────────────
    const project: []const u8 = if (opts.project) |p| p else if (is_tty) proj: {
        // Fetch orgs → projects and present an interactive select.
        const me_res = client.getMe(.{
            .allocator = allocator,
            .api_url = api_url,
            .token = token,
        }) catch |err| {
            try color.err(stderr, "error");
            try stderr.print(": failed to fetch user info: {s}\n", .{@errorName(err)});
            std.process.exit(1);
        };
        if (me_res.status != 200) {
            const message = client.parseError(allocator, me_res.body) orelse try allocator.dupe(u8, "unknown error");
            try color.err(stderr, "error");
            try stderr.print(": failed to fetch user info ({d}): {s}\n", .{ me_res.status, message });
            std.process.exit(1);
        }
        const me = me_res.value orelse {
            try color.err(stderr, "error");
            try stderr.print(": invalid user info response\n", .{});
            std.process.exit(1);
        };
        const orgs = me.orgs;
        if (orgs.len == 0) {
            try color.err(stderr, "error");
            try stderr.print(": no organizations found — create one first\n", .{});
            std.process.exit(1);
        }

        // Collect all projects across all orgs, tagging each with its org name.
        const OrgProject = struct { id: []const u8, name: []const u8, org_name: []const u8 };
        var all_projects = std.ArrayListUnmanaged(OrgProject).empty;
        for (orgs) |org| {
            const proj_res = client.listProjects(.{
                .allocator = allocator,
                .api_url = api_url,
                .token = token,
                .org_id = org.id,
            }) catch continue;
            if (proj_res.status != 200) continue;
            const projects = proj_res.value orelse continue;
            for (projects.projects) |item| try all_projects.append(allocator, .{ .id = item.id, .name = item.name, .org_name = org.name });
        }

        if (all_projects.items.len == 0) {
            try color.err(stderr, "error");
            try stderr.print(": no projects found — create one first\n", .{});
            std.process.exit(1);
        }

        // When member of multiple orgs, prefix project names with org name for disambiguation.
        const multi_org = orgs.len > 1;
        const proj_options = try allocator.alloc([]const u8, all_projects.items.len);
        for (all_projects.items, 0..) |p, i| {
            proj_options[i] = if (multi_org)
                try std.fmt.allocPrint(allocator, "{s} / {s} ({s})", .{ p.org_name, p.name, p.id })
            else
                try std.fmt.allocPrint(allocator, "{s} ({s})", .{ p.name, p.id });
        }
        const proj_choice = try prompt.select("Select project", proj_options, 0) orelse {
            try color.err(stderr, "error");
            try stderr.print(": setup cancelled\n", .{});
            std.process.exit(1);
        };
        break :proj all_projects.items[proj_choice].id;
    } else {
        try color.err(stderr, "error");
        try stderr.print(": --project is required\n", .{});
        try stderr.writeAll("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n");
        std.process.exit(1);
    };

    // ── Fetch environments for the chosen project ──────────────────
    const env_res = client.listEnvironments(.{
        .allocator = allocator,
        .api_url = api_url,
        .token = token,
        .project_id = project,
    }) catch |err| {
        try color.err(stderr, "error");
        try stderr.print(": failed to fetch environments: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    if (env_res.status != 200) {
        const message = client.parseError(allocator, env_res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to fetch environments ({d}): {s}\n", .{ env_res.status, message });
        std.process.exit(1);
    }
    const envs = env_res.value orelse {
        try color.err(stderr, "error");
        try stderr.print(": invalid environments response\n", .{});
        std.process.exit(1);
    };
    const all_envs = envs.environments;

    // ── Resolve environment ────────────────────────────────────────
    const environment: []const u8 = if (opts.environment) |e| env_val: {
        // Validate the provided environment ID exists.
        var found = false;
        for (all_envs) |env| {
            if (std.mem.eql(u8, env.id, e)) { found = true; break; }
        }
        if (!found) {
            try color.err(stderr, "error");
            try stderr.print(": environment {s} not found in project {s}\n", .{ e, project });
            std.process.exit(1);
        }
        break :env_val e;
    } else if (is_tty) env_sel: {
        if (all_envs.len == 0) {
            try color.err(stderr, "error");
            try stderr.print(": no environments found in project {s}\n", .{project});
            std.process.exit(1);
        }
        const env_options = try allocator.alloc([]const u8, all_envs.len);
        for (all_envs, 0..) |e, i| {
            env_options[i] = try std.fmt.allocPrint(allocator, "{s} ({s})", .{ e.name, e.id });
        }
        const env_choice = try prompt.select("Select environment", env_options, 0) orelse {
            try color.err(stderr, "error");
            try stderr.print(": setup cancelled\n", .{});
            std.process.exit(1);
        };
        break :env_sel all_envs[env_choice].id;
    } else {
        try color.err(stderr, "error");
        try stderr.print(": --environment is required\n", .{});
        try stderr.print("  sigillo setup --project {s} --environment <ENVIRONMENT_ID>\n", .{project});
        std.process.exit(1);
    };

    try config.setScope(allocator, cwd, .{
        .project = project,
        .environment = environment,
    });

    try color.green(stdout, "✔");
    try stdout.writeAll(" Saved setup for ");
    try color.bold(stdout, cwd);
    try stdout.writeAll("\n");
    try color.blue(stdout, "  project:     ");
    try stdout.print("{s}\n", .{project});
    try color.blue(stdout, "  environment: ");
    try stdout.print("{s}\n", .{environment});
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
        try color.err(stderr, "error");
        try stderr.print(": use either --command or positional args, not both\n", .{});
        std.process.exit(1);
    }
    if (!use_shell and args.cmd.len == 0) {
        try color.err(stderr, "error");
        try stderr.print(": command is required\n", .{});
        try stderr.writeAll("  sigillo run -- env\n");
        try stderr.writeAll("  sigillo run --command 'echo $MY_SECRET'\n");
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
        try color.err(stderr, "error");
        try stderr.print(": not logged in\n", .{});
        try stderr.writeAll("  sigillo login\n");
        std.process.exit(1);
    };
    const api_url = resolved.api_url.?; // always set — defaults to https://sigillo.dev
    _ = resolved.project;
    const environment = resolved.environment orelse {
        try color.err(stderr, "error");
        try stderr.print(": environment not configured\n", .{});
        try stderr.writeAll("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n");
        std.process.exit(1);
    };

    const path = try std.fmt.allocPrint(allocator, "/api/environments/{s}/secrets/download?format=json", .{environment});
    const res = client.request(.{
        .allocator = allocator,
        .method = .GET,
        .base_url = api_url,
        .path = path,
        .token = token,
    }) catch |err| {
        try color.err(stderr, "error");
        try stderr.print(": failed to fetch secrets: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to fetch secrets ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator, res.body, .{});
    const secrets = switch (parsed) {
        .object => |value| value,
        else => {
            try color.err(stderr, "error");
            try stderr.print(": invalid secrets response\n", .{});
            std.process.exit(1);
        },
    };

    var env_map = try std.process.getEnvMap(gpa.allocator());
    defer env_map.deinit();
    try mergeSecretsIntoEnvMap(&env_map, secrets);

    // ── Mount: write secrets to a file ────────────────────────────
    const exit_code: u8 = if (opts.mount) |mount_path| mount_block: {
        const mount_format = opts.mount_format orelse "env";

        if (!isSupportedMountFormat(mount_format)) {
            try color.err(stderr, "error");
            try stderr.print(": invalid mount format '{s}' (expected: env, env-no-quotes, json, yaml, docker, dotnet-json)\n", .{mount_format});
            std.process.exit(1);
        }

        const mount_body = if (std.mem.eql(u8, mount_format, "json"))
            res.body
        else blk: {
            const mount_url = try std.fmt.allocPrint(allocator, "/api/environments/{s}/secrets/download?format={s}", .{ environment, mount_format });
            const mount_res = client.request(.{
                .allocator = allocator,
                .method = .GET,
                .base_url = api_url,
                .path = mount_url,
                .token = token,
            }) catch |err| {
                try color.err(stderr, "error");
                try stderr.print(": failed to fetch secrets for mount: {s}\n", .{@errorName(err)});
                std.process.exit(1);
            };
            if (mount_res.status != 200) {
                const message = client.parseError(allocator, mount_res.body) orelse try allocator.dupe(u8, "unknown error");
                try color.err(stderr, "error");
                try stderr.print(": failed to fetch secrets for mount ({d}): {s}\n", .{ mount_res.status, message });
                std.process.exit(1);
            }
            break :blk mount_res.body;
        };

        // Write secrets to the mount file
        {
            const file = std.fs.cwd().createFile(mount_path, .{}) catch |err| {
                try color.err(stderr, "error");
                try stderr.print(": failed to create mount file '{s}': {s}\n", .{ mount_path, @errorName(err) });
                std.process.exit(1);
            };
            defer file.close();
            try file.writeAll(mount_body);
        }

        // Clean up the mount file after the command finishes
        const MountCleanup = struct {
            path: []const u8,
            fn cleanup(self: @This()) void {
                std.fs.cwd().deleteFile(self.path) catch {};
            }
        };
        const mount_cleanup = MountCleanup{ .path = mount_path };
        defer mount_cleanup.cleanup();
        break :mount_block try runChildProcess(
            gpa.allocator(),
            &env_map,
            if (opts.disable_redaction) &.{} else try collectLikelySecretValues(allocator, secrets),
            if (use_shell) try shellCommandArgv(allocator, opts.command.?) else args.cmd,
        );
    } else try runChildProcess(
        gpa.allocator(),
        &env_map,
        if (opts.disable_redaction) &.{} else try collectLikelySecretValues(allocator, secrets),
        if (use_shell) try shellCommandArgv(allocator, opts.command.?) else args.cmd,
    );

    std.process.exit(exit_code);
}

fn runChildProcess(
    child_allocator: std.mem.Allocator,
    env_map: *std.process.EnvMap,
    redact_values: []const []const u8,
    argv: []const []const u8,
) !u8 {
    return runChildProcessWithWriters(
        child_allocator,
        env_map,
        redact_values,
        argv,
        File.stdout().writer(),
        File.stderr().writer(),
    );
}

fn runChildProcessWithWriters(
    child_allocator: std.mem.Allocator,
    env_map: *std.process.EnvMap,
    redact_values: []const []const u8,
    argv: []const []const u8,
    stdout_writer: anytype,
    stderr_writer: anytype,
) !u8 {
    var child = std.process.Child.init(argv, child_allocator);
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = if (redact_values.len == 0) .Inherit else .Pipe;
    child.stderr_behavior = if (redact_values.len == 0) .Inherit else .Pipe;
    child.env_map = env_map;

    try child.spawn();
    if (redact_values.len > 0) {
        const stdout_pipe = child.stdout.?;
        const stderr_pipe = child.stderr.?;
        child.stdout = null;
        child.stderr = null;

        var stdout_result = PipeStreamResult{};
        var stderr_result = PipeStreamResult{};

        const stdout_thread = try std.Thread.spawn(.{}, streamPipeRedactedThread, .{
            stdout_pipe,
            redact_values,
            stdout_writer,
            &stdout_result,
        });
        const stderr_thread = try std.Thread.spawn(.{}, streamPipeRedactedThread, .{
            stderr_pipe,
            redact_values,
            stderr_writer,
            &stderr_result,
        });

        stdout_thread.join();
        stderr_thread.join();

        if (stdout_result.err) |err| return err;
        if (stderr_result.err) |err| return err;
    }
    const term = try child.wait();
    return switch (term) {
        .Exited => |code| code,
        else => 1,
    };
}

const PipeStreamResult = struct {
    err: ?anyerror = null,
};

fn streamPipeRedactedThread(
    pipe: File,
    redact_values: []const []const u8,
    writer: anytype,
    result: *PipeStreamResult,
) void {
    streamPipeRedacted(pipe, redact_values, writer) catch |err| {
        result.err = err;
    };
}

fn streamPipeRedacted(
    pipe: File,
    redact_values: []const []const u8,
    writer: anytype,
) !void {
    defer pipe.close();

    const allocator = std.heap.page_allocator;
    const max_secret_len = maxSecretLen(redact_values);
    const keep_tail_len = if (max_secret_len > 0) max_secret_len - 1 else 0;

    var pending = std.ArrayListUnmanaged(u8).empty;
    defer pending.deinit(allocator);

    var read_buf: [8192]u8 = undefined;
    while (true) {
        const bytes_read = try pipe.read(&read_buf);
        if (bytes_read == 0) break;

        try pending.appendSlice(allocator, read_buf[0..bytes_read]);
        try flushRedactedPending(&pending, redact_values, keep_tail_len, false, writer);
    }

    try flushRedactedPending(&pending, redact_values, keep_tail_len, true, writer);
}

fn flushRedactedPending(
    pending: *std.ArrayListUnmanaged(u8),
    redact_values: []const []const u8,
    keep_tail_len: usize,
    flush_all: bool,
    writer: anytype,
) !void {
    if (pending.items.len == 0) return;

    const write_len = if (flush_all)
        pending.items.len
    else if (pending.items.len > keep_tail_len)
        pending.items.len - keep_tail_len
    else
        0;

    if (write_len == 0) return;

    redactInPlace(pending.items, redact_values);
    try writer.writeAll(pending.items[0..write_len]);

    const tail_len = pending.items.len - write_len;
    std.mem.copyForwards(u8, pending.items[0..tail_len], pending.items[write_len..]);
    pending.items.len = tail_len;
}

fn maxSecretLen(redact_values: []const []const u8) usize {
    var max_len: usize = 0;
    for (redact_values) |value| {
        max_len = @max(max_len, value.len);
    }
    return max_len;
}

fn redactInPlace(output: []u8, redact_values: []const []const u8) void {
    for (redact_values) |value| {
        redactSecretInPlace(output, value);
    }
}

fn isSupportedMountFormat(format: []const u8) bool {
    for (supported_mount_formats) |value| {
        if (std.mem.eql(u8, format, value)) return true;
    }
    return false;
}

fn isSupportedDownloadFormat(format: []const u8) bool {
    for (supported_download_formats) |value| {
        if (std.mem.eql(u8, format, value)) return true;
    }
    return false;
}

const ApiContext = struct {
    api_url: []const u8,
    token: []const u8,
};

const ProjectContext = struct {
    api: ApiContext,
    project_id: []const u8,
};

const EnvironmentContext = struct {
    api: ApiContext,
    environment_id: []const u8,
};

fn resolveApiContext(allocator: std.mem.Allocator, cwd: []const u8, flags: config.ResolvedConfig) !ApiContext {
    const resolved = try config.resolve(allocator, cwd, flags);
    return .{
        .api_url = resolved.api_url orelse "https://sigillo.dev",
        .token = resolved.token orelse return error.NotLoggedIn,
    };
}

fn resolveProjectContext(allocator: std.mem.Allocator, cwd: []const u8, flags: config.ResolvedConfig) !ProjectContext {
    const resolved = try config.resolve(allocator, cwd, flags);
    return .{
        .api = .{
            .api_url = resolved.api_url orelse "https://sigillo.dev",
            .token = resolved.token orelse return error.NotLoggedIn,
        },
        .project_id = resolved.project orelse return error.ProjectNotConfigured,
    };
}

fn resolveEnvironmentContext(allocator: std.mem.Allocator, cwd: []const u8, flags: config.ResolvedConfig) !EnvironmentContext {
    const resolved = try config.resolve(allocator, cwd, flags);
    return .{
        .api = .{
            .api_url = resolved.api_url orelse "https://sigillo.dev",
            .token = resolved.token orelse return error.NotLoggedIn,
        },
        .environment_id = resolved.environment orelse return error.EnvironmentNotConfigured,
    };
}

fn quoteString(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{f}", .{std.json.fmt(value, .{})});
}

fn requireApiContext(allocator: std.mem.Allocator, stderr: Writer, cwd: []const u8, flags: config.ResolvedConfig) !ApiContext {
    return resolveApiContext(allocator, cwd, flags) catch |err| switch (err) {
        error.NotLoggedIn => {
            try color.err(stderr, "error");
            try stderr.print(": not logged in\n", .{});
            try stderr.writeAll("  sigillo login\n");
            std.process.exit(1);
        },
        else => return err,
    };
}

fn requireProjectContext(allocator: std.mem.Allocator, stderr: Writer, cwd: []const u8, flags: config.ResolvedConfig) !ProjectContext {
    return resolveProjectContext(allocator, cwd, flags) catch |err| switch (err) {
        error.NotLoggedIn => {
            try color.err(stderr, "error");
            try stderr.print(": not logged in\n", .{});
            try stderr.writeAll("  sigillo login\n");
            std.process.exit(1);
        },
        error.ProjectNotConfigured => {
            try color.err(stderr, "error");
            try stderr.print(": project not configured\n", .{});
            try stderr.writeAll("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n");
            std.process.exit(1);
        },
        else => return err,
    };
}

fn requireEnvironmentContext(allocator: std.mem.Allocator, stderr: Writer, cwd: []const u8, flags: config.ResolvedConfig) !EnvironmentContext {
    return resolveEnvironmentContext(allocator, cwd, flags) catch |err| switch (err) {
        error.NotLoggedIn => {
            try color.err(stderr, "error");
            try stderr.print(": not logged in\n", .{});
            try stderr.writeAll("  sigillo login\n");
            std.process.exit(1);
        },
        error.EnvironmentNotConfigured => {
            try color.err(stderr, "error");
            try stderr.print(": environment not configured\n", .{});
            try stderr.writeAll("  sigillo setup --project <PROJECT_ID> --environment <ENVIRONMENT_ID>\n");
            std.process.exit(1);
        },
        else => return err,
    };
}

fn secretsAction(_: Secrets.Args, opts: Secrets.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireEnvironmentContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .environment = opts.environment,
    });

    const res = try client.listSecrets(.{
        .allocator = allocator,
        .api_url = ctx.api.api_url,
        .token = ctx.api.token,
        .environment_id = ctx.environment_id,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to list secrets ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    const payload = res.value.?;
    const env_id = try quoteString(allocator, payload.environmentId);
    try stdout.print("environment_id: {s}\nsecrets:\n", .{env_id});
    for (payload.secrets) |secret| {
        const id = try quoteString(allocator, secret.id);
        const name = try quoteString(allocator, secret.name);
        try stdout.print("  - id: {s}\n    name: {s}\n", .{ id, name });
    }
}

fn secretsGetAction(args: SecretsGet.Args, opts: SecretsGet.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireEnvironmentContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .environment = opts.environment,
    });

    const res = try client.getSecret(.{
        .allocator = allocator,
        .api_url = ctx.api.api_url,
        .token = ctx.api.token,
        .environment_id = ctx.environment_id,
        .name = args.name,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to get secret ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    const secret = res.value.?;
    try stdout.print(
        "environment_id: {s}\nname: {s}\nvalue: {s}\n",
        .{
            try quoteString(allocator, secret.environmentId),
            try quoteString(allocator, secret.name),
            try quoteString(allocator, secret.value),
        },
    );
}

fn secretsSetAction(args: SecretsSet.Args, opts: SecretsSet.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireEnvironmentContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .environment = opts.environment,
    });

    const res = try client.setSecret(.{
        .allocator = allocator,
        .api_url = ctx.api.api_url,
        .token = ctx.api.token,
        .environment_id = ctx.environment_id,
        .name = args.name,
        .value = args.value,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to set secret ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    const secret = res.value.?;
    try stdout.print(
        "ok: true\nenvironment_id: {s}\nid: {s}\nname: {s}\n",
        .{
            try quoteString(allocator, secret.environmentId),
            try quoteString(allocator, secret.id),
            try quoteString(allocator, secret.name),
        },
    );
}

fn secretsDeleteAction(args: SecretsDelete.Args, opts: SecretsDelete.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireEnvironmentContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .environment = opts.environment,
    });

    const res = try client.deleteSecret(.{
        .allocator = allocator,
        .api_url = ctx.api.api_url,
        .token = ctx.api.token,
        .environment_id = ctx.environment_id,
        .name = args.name,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to delete secret ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    try stdout.print("ok: true\nname: {s}\n", .{try quoteString(allocator, res.value.?.name)});
}

fn secretsDownloadAction(_: SecretsDownload.Args, opts: SecretsDownload.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireEnvironmentContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .environment = opts.environment,
    });

    const format = opts.format orelse "yaml";
    if (!isSupportedDownloadFormat(format)) {
        try color.err(stderr, "error");
        try stderr.print(": invalid download format '{s}' (expected: json, env, env-no-quotes, xargs, yaml, docker, dotnet-json)\n", .{format});
        std.process.exit(1);
    }

    const res = try client.downloadSecrets(.{
        .allocator = allocator,
        .api_url = ctx.api.api_url,
        .token = ctx.api.token,
        .environment_id = ctx.environment_id,
        .format = format,
    });
    if (res.status != 200) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to download secrets ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }

    if (std.mem.eql(u8, format, "xargs")) {
        try File.stdout().writeAll(res.body);
        return;
    }

    try stdout.print("{s}\n", .{std.mem.trimRight(u8, res.body, "\n")});
}

fn projectsAction(_: Projects.Args, opts: Projects.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const me = try client.getMe(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token });
    if (me.status != 200 or me.value == null) {
        const message = client.parseError(allocator, me.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to list projects ({d}): {s}\n", .{ me.status, message });
        std.process.exit(1);
    }

    try stdout.writeAll("projects:\n");
    for (me.value.?.orgs) |org| {
        const projects = try client.listProjects(.{
            .allocator = allocator,
            .api_url = api_ctx.api_url,
            .token = api_ctx.token,
            .org_id = org.id,
        });
        if (projects.status != 200 or projects.value == null) continue;
        for (projects.value.?.projects) |project| {
            try stdout.print(
                "  - id: {s}\n    name: {s}\n    org_id: {s}\n    org_name: {s}\n",
                .{
                    try quoteString(allocator, project.id),
                    try quoteString(allocator, project.name),
                    try quoteString(allocator, project.orgId),
                    try quoteString(allocator, org.name),
                },
            );
        }
    }
}

fn projectsCreateAction(_: ProjectsCreate.Args, opts: ProjectsCreate.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.createProject(.{
        .allocator = allocator,
        .api_url = api_ctx.api_url,
        .token = api_ctx.token,
        .org_id = opts.org,
        .name = opts.name,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to create project ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const project = res.value.?;
    try stdout.print("ok: true\nid: {s}\nname: {s}\norg_id: {s}\n", .{
        try quoteString(allocator, project.id),
        try quoteString(allocator, project.name),
        try quoteString(allocator, project.orgId),
    });
}

fn projectsGetAction(args: ProjectsGet.Args, opts: ProjectsGet.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.getProject(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token, .project_id = args.id });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to get project ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const project = res.value.?;
    try stdout.print("id: {s}\nname: {s}\norg_id: {s}\nenvironments:\n", .{
        try quoteString(allocator, project.id),
        try quoteString(allocator, project.name),
        try quoteString(allocator, project.orgId),
    });
    for (project.environments) |environment| {
        try stdout.print("  - id: {s}\n    name: {s}\n    slug: {s}\n", .{
            try quoteString(allocator, environment.id),
            try quoteString(allocator, environment.name),
            try quoteString(allocator, environment.slug),
        });
    }
}

fn projectsUpdateAction(args: ProjectsUpdate.Args, opts: ProjectsUpdate.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.updateProject(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token, .project_id = args.id, .name = opts.name });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to update project ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const project = res.value.?;
    try stdout.print("ok: true\nid: {s}\nname: {s}\norg_id: {s}\n", .{
        try quoteString(allocator, project.id),
        try quoteString(allocator, project.name),
        try quoteString(allocator, project.orgId),
    });
}

fn projectsDeleteAction(args: ProjectsDelete.Args, opts: ProjectsDelete.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.deleteProject(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token, .project_id = args.id });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to delete project ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    try stdout.print("ok: true\nid: {s}\n", .{try quoteString(allocator, res.value.?.id)});
}

fn environmentsAction(_: Environments.Args, opts: Environments.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const ctx = try requireProjectContext(allocator, stderr, cwd, .{
        .token = opts.token,
        .api_url = opts.api_url,
        .project = opts.project,
    });
    const res = try client.listEnvironments(.{ .allocator = allocator, .api_url = ctx.api.api_url, .token = ctx.api.token, .project_id = ctx.project_id });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to list environments ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    try stdout.print("project_id: {s}\nenvironments:\n", .{try quoteString(allocator, ctx.project_id)});
    for (res.value.?.environments) |environment| {
        try stdout.print("  - id: {s}\n    name: {s}\n    slug: {s}\n", .{
            try quoteString(allocator, environment.id),
            try quoteString(allocator, environment.name),
            try quoteString(allocator, environment.slug),
        });
    }
}

fn environmentsCreateAction(_: EnvironmentsCreate.Args, opts: EnvironmentsCreate.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.createEnvironment(.{
        .allocator = allocator,
        .api_url = api_ctx.api_url,
        .token = api_ctx.token,
        .project_id = opts.project,
        .name = opts.name,
        .slug = opts.slug,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to create environment ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const environment = res.value.?;
    try stdout.print("ok: true\nid: {s}\nproject_id: {s}\nname: {s}\nslug: {s}\n", .{
        try quoteString(allocator, environment.id),
        try quoteString(allocator, environment.projectId),
        try quoteString(allocator, environment.name),
        try quoteString(allocator, environment.slug),
    });
}

fn environmentsGetAction(args: EnvironmentsGet.Args, opts: EnvironmentsGet.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.getEnvironment(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token, .environment_id = args.id });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to get environment ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const environment = res.value.?;
    try stdout.print("id: {s}\nproject_id: {s}\nname: {s}\nslug: {s}\n", .{
        try quoteString(allocator, environment.id),
        try quoteString(allocator, environment.projectId),
        try quoteString(allocator, environment.name),
        try quoteString(allocator, environment.slug),
    });
}

fn environmentsRenameAction(args: EnvironmentsRename.Args, opts: EnvironmentsRename.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    if (opts.name == null and opts.slug == null) {
        try color.err(stderr, "error");
        try stderr.print(": pass --name, --slug, or both\n", .{});
        std.process.exit(1);
    }
    const res = try client.updateEnvironment(.{
        .allocator = allocator,
        .api_url = api_ctx.api_url,
        .token = api_ctx.token,
        .environment_id = args.id,
        .name = opts.name,
        .slug = opts.slug,
    });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to rename environment ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    const environment = res.value.?;
    try stdout.print("ok: true\nid: {s}\nproject_id: {s}\nname: {s}\nslug: {s}\n", .{
        try quoteString(allocator, environment.id),
        try quoteString(allocator, environment.projectId),
        try quoteString(allocator, environment.name),
        try quoteString(allocator, environment.slug),
    });
}

fn environmentsDeleteAction(args: EnvironmentsDelete.Args, opts: EnvironmentsDelete.Options) !void {
    const stderr = getStderr();
    const stdout = getStdout();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa.allocator());
    defer arena.deinit();
    const allocator = arena.allocator();
    const cwd = try config.getCwd(allocator);
    const api_ctx = try requireApiContext(allocator, stderr, cwd, .{ .token = opts.token, .api_url = opts.api_url });
    const res = try client.deleteEnvironment(.{ .allocator = allocator, .api_url = api_ctx.api_url, .token = api_ctx.token, .environment_id = args.id });
    if (res.status != 200 or res.value == null) {
        const message = client.parseError(allocator, res.body) orelse try allocator.dupe(u8, "unknown error");
        try color.err(stderr, "error");
        try stderr.print(": failed to delete environment ({d}): {s}\n", .{ res.status, message });
        std.process.exit(1);
    }
    try stdout.print("ok: true\nid: {s}\n", .{try quoteString(allocator, res.value.?.id)});
}

fn mergeSecretsIntoEnvMap(env_map: *std.process.EnvMap, secrets: std.json.ObjectMap) !void {
    var iter = secrets.iterator();
    while (iter.next()) |entry| {
        if (entry.value_ptr.* != .string) continue;
        try env_map.put(entry.key_ptr.*, entry.value_ptr.*.string);
    }
}

fn collectLikelySecretValues(allocator: std.mem.Allocator, secrets: std.json.ObjectMap) ![]const []const u8 {
    var values = std.ArrayListUnmanaged([]const u8).empty;
    errdefer values.deinit(allocator);

    var iter = secrets.iterator();
    while (iter.next()) |entry| {
        if (entry.value_ptr.* != .string) continue;
        const value = entry.value_ptr.*.string;
        if (!isLikelySecretValue(value)) continue;
        try values.append(allocator, value);
    }

    std.mem.sort([]const u8, values.items, {}, struct {
        fn lessThan(_: void, a: []const u8, b: []const u8) bool {
            return a.len > b.len;
        }
    }.lessThan);

    return values.toOwnedSlice(allocator);
}

fn isLikelySecretValue(value: []const u8) bool {
    var start: usize = 0;
    while (start < value.len) {
        while (start < value.len and !std.ascii.isAlphanumeric(value[start])) : (start += 1) {}
        if (start >= value.len) break;

        var end = start;
        while (end < value.len and std.ascii.isAlphanumeric(value[end])) : (end += 1) {}

        const segment = value[start..end];
        if (segment.len >= 16 and shannonEntropy(segment) >= 3.5) return true;
        start = end;
    }

    return false;
}

fn shannonEntropy(value: []const u8) f64 {
    if (value.len == 0) return 0;

    var counts = [_]usize{0} ** 256;
    for (value) |char| {
        counts[char] += 1;
    }

    const len: f64 = @floatFromInt(value.len);
    var entropy: f64 = 0;
    for (counts) |count| {
        if (count == 0) continue;
        const frequency = @as(f64, @floatFromInt(count)) / len;
        entropy -= frequency * std.math.log2(frequency);
    }
    return entropy;
}

fn redactOutputAlloc(
    allocator: std.mem.Allocator,
    input: []const u8,
    redact_values: []const []const u8,
) ![]u8 {
    const output = try allocator.dupe(u8, input);
    const sorted_values = try allocator.dupe([]const u8, redact_values);
    std.mem.sort([]const u8, sorted_values, {}, struct {
        fn lessThan(_: void, a: []const u8, b: []const u8) bool {
            return a.len > b.len;
        }
    }.lessThan);

    for (sorted_values) |value| {
        redactSecretInPlace(output, value);
    }
    return output;
}

fn maskOfLen(allocator: std.mem.Allocator, len: usize) ![]u8 {
    const mask = try allocator.alloc(u8, len);
    @memset(mask, '*');
    return mask;
}

fn redactSecretInPlace(output: []u8, secret: []const u8) void {
    if (secret.len == 0 or secret.len > output.len) return;

    var start: usize = 0;
    while (std.mem.indexOfPos(u8, output, start, secret)) |index| {
        @memset(output[index .. index + secret.len], '*');
        start = index + secret.len;
    }
}

fn shellCommandArgv(allocator: std.mem.Allocator, command: []const u8) ![]const []const u8 {
    if (builtin.os.tag == .windows) {
        const shell_path = try getWindowsShellPath(allocator);
        const argv = try allocator.alloc([]const u8, 3);
        argv[0] = shell_path;
        argv[1] = "/C";
        argv[2] = command;
        return argv;
    }

    var shell_path: []const u8 = "sh";
    const env_shell = std.process.getEnvVarOwned(allocator, "SHELL") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    if (env_shell) |value| {
        if (isSupportedShell(value)) {
            shell_path = value;
        }
    }

    const argv = try allocator.alloc([]const u8, 3);
    argv[0] = shell_path;
    argv[1] = "-c";
    argv[2] = command;
    return argv;
}

fn isSupportedShell(shell_path: []const u8) bool {
    const allowed = [_][]const u8{ "/bash", "/dash", "/fish", "/zsh", "/ksh", "/csh", "/tcsh" };
    for (allowed) |suffix| {
        if (std.mem.endsWith(u8, shell_path, suffix)) return true;
    }
    return false;
}

test "high entropy strings are treated as likely secrets" {
    try std.testing.expect(isLikelySecretValue("sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890"));
    try std.testing.expect(isLikelySecretValue("9f8c2b6a1d4e7f0a3c5b8d1e4f7a9b2c"));
}

test "short or low entropy strings are not treated as secrets" {
    try std.testing.expect(!isLikelySecretValue("development"));
    try std.testing.expect(!isLikelySecretValue("current environment"));
    try std.testing.expect(!isLikelySecretValue("aaaaaaaaaaaaaaaaaaaaaaaa"));
    try std.testing.expect(!isLikelySecretValue("https://example.com/dashboard"));
    try std.testing.expect(!isLikelySecretValue("postgres://localhost:5432/app"));
}

test "entropy distinguishes random strings from structured text" {
    try std.testing.expect(shannonEntropy("Qx7mP2vN9kL4rT8yW1cB6hJ3sD5fG0zA") > 3.5);
    try std.testing.expect(shannonEntropy("dashboard") < 3.5);
}

test "collectLikelySecretValues keeps only likely secrets and sorts longer first" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, allocator,
        \\{
        \\  "PUBLIC_URL": "https://example.com/dashboard",
        \\  "ENV_NAME": "development",
        \\  "TOKEN": "sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890",
        \\  "HEX": "9f8c2b6a1d4e7f0a3c5b8d1e4f7a9b2c"
        \\}
    , .{});

    const secrets = switch (parsed) {
        .object => |value| value,
        else => unreachable,
    };

    const values = try collectLikelySecretValues(allocator, secrets);
    try std.testing.expectEqual(@as(usize, 2), values.len);
    try std.testing.expect(values[0].len >= values[1].len);
    try std.testing.expectEqualStrings("sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890", values[0]);
    try std.testing.expectEqualStrings("9f8c2b6a1d4e7f0a3c5b8d1e4f7a9b2c", values[1]);
}

test "redactOutputAlloc replaces secrets with same length mask" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const secret = "sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890";
    const input = "before sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890 after";
    const output = try redactOutputAlloc(allocator, input, &.{secret});
    const mask = try maskOfLen(allocator, secret.len);
    const expected = try std.fmt.allocPrint(allocator, "before {s} after", .{mask});

    try std.testing.expectEqualStrings(expected, output);
    try std.testing.expectEqual(secret.len, mask.len);
}

test "redaction leaves non secret values visible" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const output = try redactOutputAlloc(
        allocator,
        "url=https://example.com env=development",
        &.{}
    );

    try std.testing.expectEqualStrings("url=https://example.com env=development", output);
}

test "redaction handles repeated and multiple secret values" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const token = "sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890";
    const hex = "9f8c2b6a1d4e7f0a3c5b8d1e4f7a9b2c";
    const input =
        "token=sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890\nhex=9f8c2b6a1d4e7f0a3c5b8d1e4f7a9b2c\nagain=sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890";

    const output = try redactOutputAlloc(allocator, input, &.{ token, hex });
    const token_mask = try maskOfLen(allocator, token.len);
    const hex_mask = try maskOfLen(allocator, hex.len);
    const expected = try std.fmt.allocPrint(
        allocator,
        "token={s}\nhex={s}\nagain={s}",
        .{ token_mask, hex_mask, token_mask },
    );

    try std.testing.expectEqualStrings(expected, output);
}

test "longer secrets are redacted before shorter overlapping ones" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const long = "abcd1234wxyz9876";
    const short = "1234wxyz";
    const output = try redactOutputAlloc(allocator, "value=abcd1234wxyz9876", &.{ short, long });

    try std.testing.expectEqualStrings("value=****************", output);
}

test "streaming redaction handles chunk boundaries" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pending = std.ArrayListUnmanaged(u8).empty;
    defer pending.deinit(allocator);
    var output = std.ArrayListUnmanaged(u8).empty;
    defer output.deinit(allocator);

    try pending.appendSlice(allocator, "prefix sk_live_ab");
    try flushRedactedPending(
        &pending,
        &.{"sk_live_abcdefghijklmnop"},
        "sk_live_abcdefghijklmnop".len - 1,
        false,
        output.writer(allocator),
    );

    try pending.appendSlice(allocator, "cdefghijklmnop suffix");
    try flushRedactedPending(
        &pending,
        &.{"sk_live_abcdefghijklmnop"},
        "sk_live_abcdefghijklmnop".len - 1,
        true,
        output.writer(allocator),
    );

    try std.testing.expectEqualStrings("prefix ************************ suffix", output.items);
}

test "runChildProcessWithWriters streams large stdout without buffering it all" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var env_map = std.process.EnvMap.init(allocator);
    defer env_map.deinit();

    const argv = try shellCommandArgv(
        allocator,
        "yes x | tr -d '\n' | head -c 20000000",
    );

    var stdout_buf = std.ArrayListUnmanaged(u8).empty;
    defer stdout_buf.deinit(allocator);
    var stderr_buf = std.ArrayListUnmanaged(u8).empty;
    defer stderr_buf.deinit(allocator);

    const exit_code = try runChildProcessWithWriters(
        allocator,
        &env_map,
        &.{"not-a-real-secret"},
        argv,
        stdout_buf.writer(allocator),
        stderr_buf.writer(allocator),
    );

    try std.testing.expectEqual(@as(u8, 0), exit_code);
    try std.testing.expectEqual(@as(usize, 20_000_000), stdout_buf.items.len);
    try std.testing.expectEqual(@as(usize, 0), stderr_buf.items.len);
    try std.testing.expect(std.mem.allEqual(u8, stdout_buf.items, 'x'));
}

test "run command keeps argv after double dash as positional command" {
    const State = struct {
        var captured_cmd: []const []const u8 = &.{};
        var used_disable_redaction = false;
        var used_command: ?[]const u8 = null;

        fn action(args: Run.Args, opts: Run.Options) !void {
            captured_cmd = try std.testing.allocator.dupe([]const u8, args.cmd);
            used_disable_redaction = opts.disable_redaction;
            used_command = opts.command;
        }
    };

    defer if (State.captured_cmd.len > 0) std.testing.allocator.free(State.captured_cmd);

    const TestRun = Run.bind(State.action);

    var app = zeke.App(.{TestRun}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "run", "--", "next", "dev" });

    try std.testing.expectEqual(@as(usize, 2), State.captured_cmd.len);
    try std.testing.expectEqualStrings("next", State.captured_cmd[0]);
    try std.testing.expectEqualStrings("dev", State.captured_cmd[1]);
    try std.testing.expectEqual(@as(?[]const u8, null), State.used_command);
    try std.testing.expect(!State.used_disable_redaction);
}

test "run command still parses flags before double dash" {
    const State = struct {
        var captured_cmd: []const []const u8 = &.{};
        var used_disable_redaction = false;

        fn action(args: Run.Args, opts: Run.Options) !void {
            captured_cmd = try std.testing.allocator.dupe([]const u8, args.cmd);
            used_disable_redaction = opts.disable_redaction;
        }
    };

    defer if (State.captured_cmd.len > 0) std.testing.allocator.free(State.captured_cmd);

    const TestRun = Run.bind(State.action);

    var app = zeke.App(.{TestRun}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "run", "--disable-redaction", "--", "next", "dev" });

    try std.testing.expectEqual(@as(usize, 2), State.captured_cmd.len);
    try std.testing.expectEqualStrings("next", State.captured_cmd[0]);
    try std.testing.expectEqualStrings("dev", State.captured_cmd[1]);
    try std.testing.expect(State.used_disable_redaction);
}

test "run command parses --mount and --mount-format" {
    const State = struct {
        var mount: ?[]const u8 = null;
        var mount_format: ?[]const u8 = null;
        var captured_cmd: []const []const u8 = &.{};

        fn action(args: Run.Args, opts: Run.Options) !void {
            mount = opts.mount;
            mount_format = opts.mount_format;
            captured_cmd = try std.testing.allocator.dupe([]const u8, args.cmd);
        }
    };

    defer if (State.captured_cmd.len > 0) std.testing.allocator.free(State.captured_cmd);

    const TestRun = Run.bind(State.action);

    var app = zeke.App(.{TestRun}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "run", "--mount", ".env", "--", "npm", "start" });

    try std.testing.expectEqualStrings(".env", State.mount.?);
    try std.testing.expect(State.mount_format == null);
    try std.testing.expectEqual(@as(usize, 2), State.captured_cmd.len);
    try std.testing.expectEqualStrings("npm", State.captured_cmd[0]);
    try std.testing.expectEqualStrings("start", State.captured_cmd[1]);
}

test "run command parses --mount with explicit --mount-format" {
    const State = struct {
        var mount: ?[]const u8 = null;
        var mount_format: ?[]const u8 = null;

        fn action(_: Run.Args, opts: Run.Options) !void {
            mount = opts.mount;
            mount_format = opts.mount_format;
        }
    };

    const TestRun = Run.bind(State.action);

    var app = zeke.App(.{TestRun}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "run", "--mount", "config.json", "--mount-format", "json", "--", "next", "dev" });

    try std.testing.expectEqualStrings("config.json", State.mount.?);
    try std.testing.expectEqualStrings("json", State.mount_format.?);
}

test "run command leaves mount unset when flag is omitted" {
    const State = struct {
        var mount: ?[]const u8 = null;
        var mount_format: ?[]const u8 = null;

        fn action(_: Run.Args, opts: Run.Options) !void {
            mount = opts.mount;
            mount_format = opts.mount_format;
        }
    };

    const TestRun = Run.bind(State.action);

    var app = zeke.App(.{TestRun}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "run", "--", "env" });

    try std.testing.expect(State.mount == null);
    try std.testing.expect(State.mount_format == null);
}

test "supported mount formats match documented values" {
    for (supported_mount_formats) |format| {
        try std.testing.expect(isSupportedMountFormat(format));
    }

    try std.testing.expect(!isSupportedMountFormat("toml"));
}

test "supported download formats match documented values" {
    for (supported_download_formats) |format| {
        try std.testing.expect(isSupportedDownloadFormat(format));
    }

    try std.testing.expect(!isSupportedDownloadFormat("toml"));
}

test "secrets download parses explicit format" {
    const State = struct {
        var format: ?[]const u8 = null;

        fn action(_: SecretsDownload.Args, opts: SecretsDownload.Options) !void {
            format = opts.format;
        }
    };

    const TestSecretsDownload = SecretsDownload.bind(State.action);
    var app = zeke.App(.{TestSecretsDownload}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "secrets", "download", "--format", "xargs" });

    try std.testing.expectEqualStrings("xargs", State.format.?);
}

test "secrets download leaves format unset when omitted" {
    const State = struct {
        var format: ?[]const u8 = null;

        fn action(_: SecretsDownload.Args, opts: SecretsDownload.Options) !void {
            format = opts.format;
        }
    };

    const TestSecretsDownload = SecretsDownload.bind(State.action);
    var app = zeke.App(.{TestSecretsDownload}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "secrets", "download" });

    try std.testing.expect(State.format == null);
}

test "secrets command parses environment override" {
    const State = struct {
        var environment: ?[]const u8 = null;

        fn action(_: Secrets.Args, opts: Secrets.Options) !void {
            environment = opts.environment;
        }
    };

    const TestSecrets = Secrets.bind(State.action);
    var app = zeke.App(.{TestSecrets}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "secrets", "--environment", "env_123" });

    try std.testing.expectEqualStrings("env_123", State.environment.?);
}

test "projects create parses required options" {
    const State = struct {
        var org: ?[]const u8 = null;
        var name: ?[]const u8 = null;

        fn action(_: ProjectsCreate.Args, opts: ProjectsCreate.Options) !void {
            org = opts.org;
            name = opts.name;
        }
    };

    const TestProjectsCreate = ProjectsCreate.bind(State.action);
    var app = zeke.App(.{TestProjectsCreate}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "projects", "create", "--org", "org_123", "--name", "backend" });

    try std.testing.expectEqualStrings("org_123", State.org.?);
    try std.testing.expectEqualStrings("backend", State.name.?);
}

test "environments rename parses optional name and slug" {
    const State = struct {
        var id: ?[]const u8 = null;
        var name: ?[]const u8 = null;
        var slug: ?[]const u8 = null;

        fn action(args: EnvironmentsRename.Args, opts: EnvironmentsRename.Options) !void {
            id = args.id;
            name = opts.name;
            slug = opts.slug;
        }
    };

    const TestEnvironmentsRename = EnvironmentsRename.bind(State.action);
    var app = zeke.App(.{TestEnvironmentsRename}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "environments", "rename", "env_123", "--name", "prod", "--slug", "production" });

    try std.testing.expectEqualStrings("env_123", State.id.?);
    try std.testing.expectEqualStrings("prod", State.name.?);
    try std.testing.expectEqualStrings("production", State.slug.?);
}

test "login parses token option" {
    const State = struct {
        var token: ?[]const u8 = null;
        var scope: ?[]const u8 = null;

        fn action(_: Login.Args, opts: Login.Options) !void {
            token = opts.token;
            scope = opts.scope;
        }
    };

    const TestLogin = Login.bind(State.action);
    var app = zeke.App(.{TestLogin}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "login", "--token", "sig_test_123", "--scope", "/" });

    try std.testing.expectEqualStrings("sig_test_123", State.token.?);
    try std.testing.expectEqualStrings("/", State.scope.?);
}

test "login leaves scope unset when flag is omitted" {
    const State = struct {
        var token: ?[]const u8 = null;
        var scope: ?[]const u8 = null;

        fn action(_: Login.Args, opts: Login.Options) !void {
            token = opts.token;
            scope = opts.scope;
        }
    };

    const TestLogin = Login.bind(State.action);
    var app = zeke.App(.{TestLogin}).init(std.testing.allocator, "sigillo");
    try app.dispatch(&.{ "login", "--token", "sig_test_123" });

    try std.testing.expectEqualStrings("sig_test_123", State.token.?);
    try std.testing.expect(State.scope == null);
}

fn openBrowser(allocator: std.mem.Allocator, url: []const u8) void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .macos => &.{ "open", url },
        .windows => blk: {
            const shell_path = getWindowsShellPath(allocator) catch return;
            break :blk &.{ shell_path, "/C", "start", "", url };
        },
        else => &.{ "xdg-open", url },
    };

    var child = std.process.Child.init(argv, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    child.spawn() catch return;
}

fn getWindowsShellPath(allocator: std.mem.Allocator) ![]const u8 {
    return std.process.getEnvVarOwned(allocator, "COMSPEC") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "cmd.exe"),
        else => return err,
    };
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
        Secrets.bind(secretsAction),
        SecretsGet.bind(secretsGetAction),
        SecretsSet.bind(secretsSetAction),
        SecretsDelete.bind(secretsDeleteAction),
        SecretsDownload.bind(secretsDownloadAction),
        Projects.bind(projectsAction),
        ProjectsCreate.bind(projectsCreateAction),
        ProjectsGet.bind(projectsGetAction),
        ProjectsUpdate.bind(projectsUpdateAction),
        ProjectsDelete.bind(projectsDeleteAction),
        Environments.bind(environmentsAction),
        EnvironmentsCreate.bind(environmentsCreateAction),
        EnvironmentsGet.bind(environmentsGetAction),
        EnvironmentsRename.bind(environmentsRenameAction),
        EnvironmentsDelete.bind(environmentsDeleteAction),
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

    app.dispatch(argv.items) catch |err| {
        const stderr = getStderr();
        stderr.print("error: {s}\n", .{@errorName(err)}) catch {};
        std.process.exit(1);
    };
}
