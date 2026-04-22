// Generate typed Zig API structs from the app OpenAPI document for the CLI.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  nullable?: boolean
  enum?: unknown[]
  additionalProperties?: JsonSchema | boolean
}

const root = resolve(import.meta.dirname, '..')
const openapiPath = resolve(root, '../app/src/openapi.json')
const outputPath = resolve(root, 'zig/src/generated/sigillo-api.zig')

const doc = JSON.parse(readFileSync(openapiPath, 'utf8')) as {
  paths: Record<string, Record<string, any>>
}

const operations = [
  { name: 'MeResponse', path: '/api/v0/me', method: 'get', source: 'response' },
  { name: 'OrgListResponse', path: '/api/v0/orgs', method: 'get', source: 'response' },
  { name: 'ProjectListResponse', path: '/api/v0/projects', method: 'get', source: 'response' },
  { name: 'ProjectSummary', path: '/api/v0/projects/{id}', method: 'get', source: 'response' },
  { name: 'ProjectMutationResponse', path: '/api/v0/projects', method: 'post', source: 'response' },
  { name: 'ProjectCreateRequest', path: '/api/v0/projects', method: 'post', source: 'request' },
  { name: 'ProjectUpdateRequest', path: '/api/v0/projects/{id}', method: 'patch', source: 'request' },
  { name: 'ProjectDeleteResponse', path: '/api/v0/projects/{id}', method: 'delete', source: 'response' },
  { name: 'EnvironmentListResponse', path: '/api/v0/projects/{projectId}/environments', method: 'get', source: 'response' },
  { name: 'EnvironmentSummary', path: '/api/v0/projects/{projectId}/environments/{id}', method: 'get', source: 'response' },
  { name: 'EnvironmentMutationResponse', path: '/api/v0/projects/{projectId}/environments', method: 'post', source: 'response' },
  { name: 'EnvironmentCreateRequest', path: '/api/v0/projects/{projectId}/environments', method: 'post', source: 'request' },
  { name: 'EnvironmentUpdateRequest', path: '/api/v0/projects/{projectId}/environments/{id}', method: 'patch', source: 'request' },
  { name: 'EnvironmentDeleteResponse', path: '/api/v0/projects/{projectId}/environments/{id}', method: 'delete', source: 'response' },
  { name: 'SecretListResponse', path: '/api/v0/projects/{projectId}/environments/{environmentId}/secrets', method: 'get', source: 'response' },
  { name: 'SecretValueResponse', path: '/api/v0/projects/{projectId}/environments/{environmentId}/secrets/{name}', method: 'get', source: 'response' },
  { name: 'SecretMutationResponse', path: '/api/v0/projects/{projectId}/environments/{environmentId}/secrets', method: 'post', source: 'response' },
  { name: 'SecretSetRequest', path: '/api/v0/projects/{projectId}/environments/{environmentId}/secrets', method: 'post', source: 'request' },
  { name: 'SecretDeleteResponse', path: '/api/v0/projects/{projectId}/environments/{environmentId}/secrets/{name}', method: 'delete', source: 'response' },
] as const

const emitted = new Set<string>()
const blocks: string[] = []

function pascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')
}

function getSchema(args: {
  path: string
  method: string
  source: 'request' | 'response'
}): JsonSchema {
  const operation = doc.paths[args.path]?.[args.method]
  if (!operation) throw new Error(`Missing operation for ${args.method.toUpperCase()} ${args.path}`)
  if (args.source === 'request') {
    return operation.requestBody.content['application/json'].schema
  }

  const response = operation.responses['200']
  return response.content['application/json']?.schema ?? response.content['*/*']?.schema
}

function emitSchema(name: string, schema: JsonSchema): string {
  if (schema.nullable) {
    return `?${emitSchema(name, { ...schema, nullable: false })}`
  }

  if (schema.enum && schema.enum.length === 1) {
    const only = schema.enum[0]
    if (typeof only === 'boolean') return 'bool'
    if (typeof only === 'string') return '[]const u8'
  }

  if (schema.type === 'string') return '[]const u8'
  if (schema.type === 'integer') return 'i64'
  if (schema.type === 'number') return 'f64'
  if (schema.type === 'boolean') return 'bool'
  if (schema.type === 'array') {
    return `[]const ${emitSchema(`${name}Item`, schema.items ?? {})}`
  }

  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties) return 'std.json.Value'
    const typeName = pascalCase(name)
    if (!emitted.has(typeName)) {
      emitted.add(typeName)
      const required = new Set(schema.required ?? [])
      const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
        const fieldType = emitSchema(`${typeName}${pascalCase(key)}`, value)
        if (required.has(key)) return `    ${key}: ${fieldType},`
        return `    ${key}: ?${fieldType} = null,`
      })
      blocks.push(`pub const ${typeName} = struct {\n${fields.join('\n')}\n};`)
    }
    return typeName
  }

  return 'std.json.Value'
}

for (const operation of operations) {
  emitSchema(operation.name, getSchema(operation))
}

const output = [
  '// Generated Zig API structs from app/src/openapi.json for the CLI.',
  'const std = @import("std");',
  '',
  ...blocks,
  '',
].join('\n')

writeFileSync(outputPath, output)
console.log(`Wrote ${outputPath}`)
