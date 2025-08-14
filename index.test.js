import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ListSecretVersionIdsCommand,
    UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { trimStagesWithClient, pickOldestStageToDeprecate } from './index.js';

class MockSecretsManagerClient {
    constructor({ listPages = [], failOnUpdate = false } = {}) {
        this.listPages = listPages; // array of { Versions, NextToken? }
        this.failOnUpdate = failOnUpdate;
        this.calls = []; // record of { cmdName, input }
        this._page = 0;
    }

    async send(cmd) {
        const cmdName = cmd?.constructor?.name || 'UnknownCommand';
        this.calls.push({ cmdName, input: cmd.input });

        if (cmd instanceof ListSecretVersionIdsCommand) {
            // Serve the next page (or last page repeatedly if over-read)
            const page = this.listPages[Math.min(this._page, this.listPages.length - 1)] || { Versions: [] };
            this._page++;
            // simulate AWS structure
            return {
                Versions: page.Versions || [],
                NextToken: page.NextToken,
            };
        }

        if (cmd instanceof UpdateSecretVersionStageCommand) {
            if (this.failOnUpdate) {
                const e = new Error('Update failed (simulated)');
                e.name = 'MockUpdateError';
                throw e;
            }
            // Return minimal shape
            return { $metadata: { httpStatusCode: 200 } };
        }

        throw new Error(`Unhandled command in mock: ${cmdName}`);
    }
}

function makeVersion(versionId, created, stages = []) {
    return {
        VersionId: versionId,
        CreatedDate: new Date(created),
        VersionStages: stages,
    };
}

test('pickOldestStageToDeprecate returns null when count <= threshold', () => {
    const result = pickOldestStageToDeprecate([
        { stage: 'a', versionId: 'v1', createdDate: new Date('2024-01-01') },
        { stage: 'b', versionId: 'v2', createdDate: new Date('2024-01-02') },
    ], 2);
    assert.equal(result, null);
});

test('does not trim when manageable stages <= threshold', async () => {
    const client = new MockSecretsManagerClient({
        listPages: [
            {
                Versions: [
                    makeVersion('v1', '2024-01-01', ['custom-1']),
                    makeVersion('v2', '2024-01-02', ['AWSCURRENT']), // excluded
                ],
            },
        ],
    });

    const result = await trimStagesWithClient(client, {
        secretId: 'my/secret',
        threshold: 1, // only 1 manageable stage exists
    });

    assert.equal(result.trimmed, false);
    // We expect one List call and no Update calls
    const listCalls = client.calls.filter(c => c.cmdName === 'ListSecretVersionIdsCommand');
    const updateCalls = client.calls.filter(c => c.cmdName === 'UpdateSecretVersionStageCommand');
    assert.equal(listCalls.length, 1);
    assert.equal(updateCalls.length, 0);
});

test('trims oldest manageable stage when over threshold', async () => {
    const client = new MockSecretsManagerClient({
        listPages: [
            {
                Versions: [
                    makeVersion('v1', '2024-01-01', ['stage-a']), // oldest manageable
                    makeVersion('v2', '2024-01-03', ['stage-b']),
                    makeVersion('v3', '2024-01-02', ['AWSCURRENT']), // excluded
                ],
            },
        ],
    });

    const result = await trimStagesWithClient(client, {
        secretId: 'my/secret',
        threshold: 1, // there are 2 manageable stages: a, b -> exceed threshold
        excludeStages: new Set(['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING']),
        dryRun: false,
    });

    assert.equal(result.trimmed, true);
    assert.deepEqual(result.removed, { stage: 'stage-a', versionId: 'v1' });

    const updateCalls = client.calls.filter(c => c.cmdName === 'UpdateSecretVersionStageCommand');
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].input, {
        SecretId: 'my/secret',
        VersionStage: 'stage-a',
        RemoveFromVersionId: 'v1',
    });
});

test('respects excludeStages (never removes AWSCURRENT, AWSPREVIOUS, AWSPENDING)', async () => {
    const client = new MockSecretsManagerClient({
        listPages: [
            {
                Versions: [
                    makeVersion('v1', '2024-01-01', ['AWSPREVIOUS']), // excluded
                    makeVersion('v2', '2024-01-02', ['custom-a']),
                    makeVersion('v3', '2024-01-03', ['custom-b']),
                ],
            },
        ],
    });

    const result = await trimStagesWithClient(client, {
        secretId: 'my/secret',
        threshold: 1,
        excludeStages: new Set(['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING']),
    });

    // manageable stages are [custom-a, custom-b] => oldest is custom-a on v2
    assert.equal(result.trimmed, true);
    assert.deepEqual(result.removed, { stage: 'custom-a', versionId: 'v2' });
});

test('handles pagination across multiple pages', async () => {
    const client = new MockSecretsManagerClient({
        listPages: [
            {
                Versions: [
                    makeVersion('v1', '2024-01-01', ['s1']),
                    makeVersion('v2', '2024-01-02', ['s2']),
                ],
                NextToken: 'next-1',
            },
            {
                Versions: [
                    makeVersion('v3', '2024-01-03', ['s3']),
                    makeVersion('v4', '2024-01-04', ['AWSCURRENT']), // excluded
                ],
                NextToken: undefined,
            },
        ],
    });

    const result = await trimStagesWithClient(client, {
        secretId: 'my/secret',
        threshold: 2, // 3 manageable stages (s1, s2, s3) -> exceed
        excludeStages: new Set(['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING']),
    });

    assert.equal(result.trimmed, true);
    assert.deepEqual(result.removed, { stage: 's1', versionId: 'v1' });

    const listCalls = client.calls.filter(c => c.cmdName === 'ListSecretVersionIdsCommand');
    assert.equal(listCalls.length, 2);
});

test('dryRun does not call UpdateSecretVersionStageCommand', async () => {
    const client = new MockSecretsManagerClient({
        listPages: [
            { Versions: [ makeVersion('v1', '2024-01-01', ['s1']), makeVersion('v2', '2024-01-02', ['s2']) ] },
        ],
    });

    const result = await trimStagesWithClient(client, {
        secretId: 'my/secret',
        threshold: 1,
        dryRun: true,
    });

    assert.equal(result.trimmed, false);
    assert.deepEqual(result.removed, { stage: 's1', versionId: 'v1' });
    const updateCalls = client.calls.filter(c => c.cmdName === 'UpdateSecretVersionStageCommand');
    assert.equal(updateCalls.length, 0);
});
