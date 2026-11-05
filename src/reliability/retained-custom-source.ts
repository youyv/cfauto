import {expandBusinessSources} from './shared-source';
import { GenerationSourcePins } from './generation-source-pins';
import { TEMPLATES } from '../config/templates';
import type { SqlDatabase } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { canonical, identifier, ReliabilityError, sha256 } from './protocol';
import { customSourceCode, type CustomSourceArtifact } from './source-artifact';
import type { DeploymentPlan } from './deployment-plan';

const unavailable = (): never => { throw new ReliabilityError('NOT_READY', 503); };
/** Internal global-DO reader. No HTTP, KV fallback, source bytes or key material in
 * the reference index. Immutable task snapshots remain pinned even on failed reads;
 * a future GC must honor these pins (including their generation and encryption key).
 * Migrated custom deployments without retained verified bytes fail closed. */
export class RetainedCustomSource {
    private readonly migrated: GenerationSourcePins;
    constructor(private readonly db: SqlDatabase, private readonly sealed: SealedStore) {
        this.migrated = new GenerationSourcePins(db,sealed);
        db.rows('CREATE TABLE IF NOT EXISTS retained_source_references (generation TEXT NOT NULL, template TEXT NOT NULL, digest TEXT NOT NULL, snapshot TEXT NOT NULL, account TEXT NOT NULL, key_id TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(generation,template,digest,snapshot))');
    }
    async load(generation: string, template: string, digest: string): Promise<CustomSourceArtifact> {
        identifier(generation);
        if (!Object.hasOwn(TEMPLATES,template) || !/^[a-f0-9]{64}$/.test(digest)) return unavailable();
        const frozen=this.db.transaction(()=>{
            // Only a completed full intent that actually advanced the version can
            // supply the currently selected fixed source, not a partial/unknown run.
            const run=this.db.rows<{task:string;payload:string}>("SELECT task,payload FROM deployment_runs WHERE generation=? AND template=? AND scope='full' AND status='succeeded' AND finished IS NOT NULL AND json_extract(payload,'$.customSha')=? AND json_extract(result,'$.advanced')=1 ORDER BY seq DESC LIMIT 1",generation,template,digest)[0];
            if (!run) return null;
            let plan: DeploymentPlan;
            try { plan=JSON.parse(run.payload); } catch { return unavailable(); }
            if (plan.template!==template || plan.mode!=='fixed' || plan.sha!==null || plan.customSha!==digest || plan.sourceDigest!==digest || plan.sourceIdentity!=='' || !plan.targets?.length) return unavailable();
            const target=plan.targets[0];
            const row=this.db.rows<{snapshot:string;state:string}>('SELECT snapshot,state FROM dispatch_outbox WHERE task=? AND account=?',run.task,target.account)[0];
            if (!row || row.state!=='terminal') return unavailable();
            const context:SealedContext={id:row.snapshot,kind:'task_snapshot',account:target.account,generation};
            const info=this.sealed.info(context);
            this.db.rows('INSERT OR IGNORE INTO retained_source_references VALUES (?,?,?,?,?,?,?)',generation,template,digest,row.snapshot,target.account,info.keyId,run.task);
            return {context,target};
        });
        if (!frozen) return this.migrated.load(generation,template,digest);
        const snapshot=await this.sealed.get(frozen.context) as any;
        if (snapshot?.schema!==1 || snapshot.account!==frozen.context.account || snapshot.generation!==generation || snapshot.operation?.operation?.account!==frozen.context.account) return unavailable();
        const command=expandBusinessSources(snapshot.operation.operation).commands?.[frozen.target.steps[0]];
        if (command?.kind!=='manual_upload' || command.template!==template || command.worker!==frozen.target.worker) return unavailable();
        const artifact=command.artifact;
        if (!artifact || canonical(Object.keys(artifact).sort())!==canonical(['code','digest','kind','template']) || artifact.kind!=='custom' || artifact.template!==template || artifact.digest!==digest) return unavailable();
        customSourceCode(artifact.code);
        if (await sha256(artifact.code)!==digest) return unavailable();
        return {kind:'custom',template,code:artifact.code,digest};
    }
}
