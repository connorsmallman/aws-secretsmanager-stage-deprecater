import * as core from "@actions/core";
import {
    SecretsManagerClient,
    ListSecretVersionIdsCommand,
    UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import process from "node:process";

export function pickOldestStageToDeprecate(stages, threshold) {
    if (stages.length <= threshold) return null;
    const sorted = stages.toSorted((a, b) => a.createdDate - b.createdDate);
    return sorted[0];
}

export async function trimStagesWithClient(client, {
    secretId,
    threshold = 18,
    excludeStages = new Set(["AWSCURRENT", "AWSPREVIOUS", "AWSPENDING"]),
    dryRun = false,
}) {
    let nextToken = undefined;
    const labeled = [];

    do {
        const command = new ListSecretVersionIdsCommand({
            SecretId: secretId,
            IncludeDeprecated: true,
            NextToken: nextToken,
            MaxResults: 100,
        });
        const resp = await client.send(command);

        for (const v of resp.Versions || []) {
            const { VersionId, CreatedDate, VersionStages } = v;
            if (!VersionStages || VersionStages.length === 0) {
                continue;
            }
            for (const stage of VersionStages) {
                labeled.push({
                    stage,
                    versionId: VersionId,
                    createdDate: CreatedDate ? new Date(CreatedDate) : new Date(0),
                });
            }
        }
        nextToken = resp.NextToken;
    } while (nextToken);

    const latestByStage = new Map();
    for (const e of labeled) {
        if (excludeStages.has(e.stage)) {
            continue;
        }
        const prev = latestByStage.get(e.stage);
        if (!prev || e.createdDate > prev.createdDate) {
            latestByStage.set(e.stage, e);
        }
    }
    const uniqueStages = Array.from(latestByStage.values());

    const candidate = pickOldestStageToDeprecate(uniqueStages, threshold);
    if (!candidate) {
        return { trimmed: false, count: labeled.length, manageableCount: uniqueStages.length };
    }

    if (dryRun) {
        return { trimmed: false, removed: { stage: candidate.stage, versionId: candidate.versionId }, count: labeled.length, manageableCount: uniqueStages.length };
    }

    const command = new UpdateSecretVersionStageCommand({
        SecretId: secretId,
        VersionStage: candidate.stage,
        RemoveFromVersionId: candidate.versionId,
    });
    await client.send(command);

    return {
        trimmed: true,
        removed: { stage: candidate.stage, versionId: candidate.versionId },
        count: labeled.length,
        manageableCount: uniqueStages.length,
    };
}

async function run() {
    try {
        const secretId = core.getInput("secret-id", { required: true });
        const region = core.getInput("aws-region", { required: true });
        const threshold = parseInt(core.getInput("threshold") || "18", 10);
        const dryRun = (core.getInput("dry-run") || "false").toLowerCase() === "true";
        const excludeStagesRaw = core.getInput("exclude-stages") || "AWSCURRENT,AWSPREVIOUS,AWSPENDING";
        const excludeStages = new Set(
            excludeStagesRaw.split(",").map(s => s.trim()).filter(Boolean)
        );

        const client = new SecretsManagerClient({ region });

        const result = await trimStagesWithClient(client, {
            secretId,
            threshold,
            excludeStages,
            dryRun,
        });

        core.info(`Manageable stages: ${result.manageableCount}; trimmed: ${result.trimmed}`);
        if (result.removed) {
            core.info(`Removed stage "${result.removed.stage}" from version ${result.removed.versionId}`);
        }
        core.setOutput("trimmed", String(result.trimmed));
    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}

if (process.env.GITHUB_ACTIONS) {
    // Only auto-run inside Actions; makes local `node index.js` a no-op for tests.
    run();
}
