// Generated Zig API structs from app/src/openapi.json for the CLI.
const std = @import("std");

pub const MeResponseUser = struct {
    id: []const u8,
    name: []const u8,
    email: []const u8,
};
pub const MeResponseOrgsItem = struct {
    id: []const u8,
    name: []const u8,
    role: []const u8,
};
pub const MeResponse = struct {
    user: MeResponseUser,
    orgs: []const MeResponseOrgsItem,
};
pub const OrgListResponseOrgsItem = struct {
    id: []const u8,
    name: []const u8,
    createdAt: i64,
    updatedAt: i64,
    role: []const u8,
};
pub const OrgListResponse = struct {
    orgs: []const OrgListResponseOrgsItem,
};
pub const ProjectListResponseProjectsItemEnvironmentsItem = struct {
    id: []const u8,
    projectId: []const u8,
    name: []const u8,
    slug: []const u8,
    createdAt: i64,
    updatedAt: i64,
};
pub const ProjectListResponseProjectsItem = struct {
    id: []const u8,
    orgId: []const u8,
    name: []const u8,
    createdAt: i64,
    updatedAt: i64,
    environments: []const ProjectListResponseProjectsItemEnvironmentsItem,
};
pub const ProjectListResponse = struct {
    projects: []const ProjectListResponseProjectsItem,
};
pub const ProjectSummaryEnvironmentsItem = struct {
    id: []const u8,
    projectId: []const u8,
    name: []const u8,
    slug: []const u8,
    createdAt: i64,
    updatedAt: i64,
};
pub const ProjectSummary = struct {
    id: []const u8,
    orgId: []const u8,
    name: []const u8,
    createdAt: i64,
    updatedAt: i64,
    environments: []const ProjectSummaryEnvironmentsItem,
};
pub const ProjectMutationResponse = struct {
    ok: bool,
    id: []const u8,
    orgId: []const u8,
    name: []const u8,
};
pub const ProjectCreateRequest = struct {
    name: []const u8,
    orgId: []const u8,
};
pub const ProjectUpdateRequest = struct {
    name: []const u8,
};
pub const ProjectDeleteResponse = struct {
    ok: bool,
    id: []const u8,
};
pub const EnvironmentListResponseEnvironmentsItem = struct {
    id: []const u8,
    projectId: []const u8,
    name: []const u8,
    slug: []const u8,
    createdAt: i64,
    updatedAt: i64,
};
pub const EnvironmentListResponse = struct {
    projectId: []const u8,
    environments: []const EnvironmentListResponseEnvironmentsItem,
};
pub const EnvironmentSummary = struct {
    id: []const u8,
    projectId: []const u8,
    name: []const u8,
    slug: []const u8,
    createdAt: i64,
    updatedAt: i64,
};
pub const EnvironmentMutationResponse = struct {
    ok: bool,
    id: []const u8,
    name: []const u8,
    slug: []const u8,
    projectId: []const u8,
};
pub const EnvironmentCreateRequest = struct {
    name: []const u8,
    slug: []const u8,
};
pub const EnvironmentUpdateRequest = struct {
    name: ?[]const u8 = null,
    slug: ?[]const u8 = null,
};
pub const EnvironmentDeleteResponse = struct {
    ok: bool,
    id: []const u8,
};
pub const SecretListResponseSecretsItem = struct {
    id: []const u8,
    name: []const u8,
    createdAt: i64,
    updatedAt: f64,
};
pub const SecretListResponse = struct {
    environmentId: []const u8,
    secrets: []const SecretListResponseSecretsItem,
};
pub const SecretValueResponse = struct {
    id: []const u8,
    name: []const u8,
    createdAt: i64,
    updatedAt: f64,
    value: []const u8,
    environmentId: []const u8,
};
pub const SecretMutationResponse = struct {
    ok: bool,
    environmentId: []const u8,
    id: []const u8,
    name: []const u8,
};
pub const SecretSetRequest = struct {
    name: []const u8,
    value: []const u8,
};
pub const SecretDeleteResponse = struct {
    ok: bool,
    name: []const u8,
};
