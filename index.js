import * as core from "@actions/core";
import {
    SecretsManagerClient,
    ListSecretVersionIdsCommand,
    UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";

async function run() {
    try {
        const secretId = core.getInput("secret-id", { required: true });
        const region = core.getInput("aws-region", { required: true });
        const threshold = parseInt(core.getInput("threshold") || "18", 10);
        const dryRun = (core.getInput("dry-run") || "false").toLowerCase() === "true";

        const excludeStagesRaw = core.getInput("exclude-stages") || "";
        const excludeStages = new Set(
            excludeStagesRaw
                .split(",")
                .map(s => s.trim())
                .filter(Boolean)
        );

        const client = new SecretsManagerClient({ region });

        // 1) Gather all current staging labels attached to versions
        let nextToken = undefined;
        const labeled = []; // { stage, versionId, createdDate }

        do {
            const command = new ListSecretVersionIdsCommand({
                SecretId: secretId,
                IncludeDeprecated: true, // include versions that might have no stages too
                NextToken: nextToken,
                MaxResults: 100,
            });
            const resp = await client.send(command);
            for (const v of resp.Versions || []) {
                const { VersionId, CreatedDate, VersionStages } = v;
                if (!VersionStages || VersionStages.length === 0) continue;
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

        // 2) Keep only the stages we’re allowed to manage
        const manageable = labeled.filter(entry => !excludeStages.has(entry.stage));

        // Count unique stages (a stage generally attaches to only one version;
        // but we’ll dedupe defensively just in case)
        const latestByStage = new Map(); // stage -> {versionId, createdDate}
        for (const e of manageable) {
            // If a stage appears on multiple versions (rare, temporary), pick the one with the newest createdDate
            const prev = latestByStage.get(e.stage);
            if (!prev || e.createdDate > prev.createdDate) latestByStage.set(e.stage, e);
        }

        const uniqueStages = Array.from(latestByStage.entries()).map(([stage, data]) => ({
            stage,
            ...data
        }));

        core.info(`Found ${uniqueStages.length} manageable staging labels (excluding: ${[...excludeStages].join(", ") || "none"})`);

        if (uniqueStages.length <= threshold) {
            core.info(`At or under threshold (${threshold}). Nothing to deprecate.`);
            core.setOutput("trimmed", "false");
            return;
        }

        // 3) Find the "oldest-labeled" one: sort by the attached version's CreatedDate ascending
        const sortedStages = uniqueStages.toSorted((a, b) => a.createdDate - b.createdDate);
        const oldest = sortedStages[0];

        core.info(
            `Threshold exceeded (${sortedStages.length} > ${threshold}). Will deprecate stage "${oldest.stage}" from version ${oldest.versionId} (created ${oldest.createdDate.toISOString()}).`
        );

        if (dryRun) {
            core.info(`DRY RUN: Skipping update.`);
            core.setOutput("trimmed", "false");
            return;
        }

        // 4) Deprecate that stage by removing it from its version
        const command = new UpdateSecretVersionStageCommand({
            SecretId: secretId,
            VersionStage: oldest.stage,
            RemoveFromVersionId: oldest.versionId,
        })
        await client.send(command);

        core.info(`Deprecated (removed) stage "${oldest.stage}" from version ${oldest.versionId}.`);
        core.setOutput("trimmed", "true");
    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}

run().catch((err) => {
    core.error("Unexpected error in run:", err);
    core.setFailed(err?.message || String(err));
    process.exit(1);
})
