export interface AcceptedBuild {
    readonly id: string;
    verify(): Promise<void>;
}
/** Release builds are immutable; source-loaded tests do not claim a package build identity. */
export declare function loadAcceptedBuild(moduleUrl?: string): Promise<AcceptedBuild | undefined>;
