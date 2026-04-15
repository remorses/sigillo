// Build script for the sigillo CLI — standalone executable.
// No native platform deps needed, just Zig stdlib HTTP + filesystem.

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const version = b.option([]const u8, "version", "Package version string") orelse "dev";
    const version_options = b.addOptions();
    version_options.addOption([]const u8, "version", version);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_mod.addImport("build_options", version_options.createModule());
    exe_mod.addImport("zeke", b.dependency("zeke", .{
        .target = target,
        .optimize = optimize,
    }).module("zeke"));

    const exe = b.addExecutable(.{
        .name = "sigillo",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    const run_exe = b.addRunArtifact(exe);
    if (b.args) |args| {
        run_exe.addArgs(args);
    }
    const run_step = b.step("run", "Run the CLI");
    run_step.dependOn(&run_exe.step);

    // Tests
    const test_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/config.zig"),
        .target = target,
        .optimize = optimize,
    });
    const test_step = b.step("test", "Run unit tests");
    const test_exe = b.addTest(.{
        .root_module = test_mod,
    });
    const run_test = b.addRunArtifact(test_exe);
    test_step.dependOn(&run_test.step);
}
