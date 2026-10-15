import { Trans, useLingui } from "@lingui/react/macro";
import type { ExecutionInputModality, ExecutionProfile, ModelCredential } from "@rakazo/contracts";
import {
  CreateExecutionProfileInput,
  EXECUTION_HARNESS_PROTOCOLS,
  EXECUTION_HARNESS_VERSIONS,
  NATIVE_EXECUTION_CAPABILITIES,
  supportedExecutionInputModalities,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type Harness = ExecutionProfile["harness"];
type Protocol = ExecutionProfile["protocol"];
const harnessLabels: Record<Harness, string> = {
  pi: "Pi",
  claude: "Claude Agent",
  codex: "Codex",
  kimi: "Kimi Code",
};
const fieldClass = "mt-3 block text-[13px] text-muted-foreground";

/** Profiles hold references only. Credentials are always selected by their exact connection ID. */
export function ExecutionProfileSettings({
  value,
  currentProfile,
  onChange,
}: {
  value: string | null;
  currentProfile?: ExecutionProfile | null;
  onChange: (profileId: string | null) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<Harness>("claude");
  const runtimeVersion = EXECUTION_HARNESS_VERSIONS[harness];
  const [provider, setProvider] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("anthropic");
  const [endpoint, setEndpoint] = useState("");
  const [modelId, setModelId] = useState("");
  const [inputModalities, setInputModalities] = useState<ExecutionInputModality[]>([]);
  const [supersedesId, setSupersedesId] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(false);
    void Promise.all([rpc.executionProfiles.list(), rpc.models.credentials()])
      .then(([nextProfiles, nextCredentials]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        setCredentials(nextCredentials);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const selected =
    profiles.find((profile) => profile.id === value) ??
    (currentProfile?.id === value ? currentProfile : undefined);
  const nativeProfile = selected?.harness !== "pi" ? selected : undefined;
  const unsupportedVersion =
    selected && selected.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[selected.harness];
  const transportInputs = nativeProfile ? supportedExecutionInputModalities(nativeProfile) : [];
  const inputLabels = { image: t`image input`, audio: t`uploaded audio` };
  const unsupportedInputs = nativeProfile
    ? (["image", "audio"] as const)
        .filter((kind) => !transportInputs.includes(kind))
        .map((kind) => inputLabels[kind])
        .join(", ")
    : "";
  const undeclaredInputs = nativeProfile
    ? transportInputs
        .filter((kind) => !nativeProfile.inputModalities?.includes(kind))
        .map((kind) => inputLabels[kind])
        .join(", ")
    : "";
  const creatableInputs = supportedExecutionInputModalities({
    harness,
    protocol,
    runtimeVersion,
    endpoint: endpoint.trim() || null,
  });
  const account = credentials.find((credential) => credential.id === selected?.credentialId);
  const availableCredentials = credentials.filter(
    (credential) => credential.hasKey && credential.authKind !== "oauth",
  );
  const providers = [...new Set(availableCredentials.map((credential) => credential.provider))];
  const accounts = availableCredentials.filter((credential) => credential.provider === provider);
  const chosenAccount = accounts.find((credential) => credential.id === credentialId);
  const canCreate =
    loaded &&
    name.trim() &&
    runtimeVersion.trim() &&
    provider &&
    chosenAccount &&
    modelId.trim() &&
    (harness === "pi" || endpoint.trim());

  function resetForm() {
    setCreating(false);
    setName("");
    setProvider("");
    setCredentialId("");
    setEndpoint("");
    setModelId("");
    setInputModalities([]);
    setSupersedesId(undefined);
    setError(null);
  }

  async function createProfile() {
    if (!canCreate || pendingRef.current) return;
    const parsed = CreateExecutionProfileInput.safeParse({
      name,
      harness,
      runtimeVersion,
      provider,
      credentialId,
      protocol,
      endpoint: endpoint.trim() || null,
      modelId,
      inputModalities,
      ...(supersedesId ? { supersedesId } : {}),
      computerId: null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t`Check the profile fields`);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const profile = await rpc.executionProfiles.create(parsed.data);
      if (!active.current) return;
      setProfiles((current) => [...current, profile]);
      onChange(profile.id);
      resetForm();
    } catch (err) {
      if (active.current) setError(errorText(err, t`Could not create profile`));
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  }

  return (
    <section data-testid="execution-profile-settings" className="mt-4">
      <label htmlFor={`${ids}-profile`} className={fieldClass}>
        <Trans>Execution profile</Trans>
        <NativeSelect
          id={`${ids}-profile`}
          className="mt-2 w-full"
          value={value ?? ""}
          disabled={pending}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <NativeSelectOption value="">{t`Pi (default)`}</NativeSelectOption>
          {value && !profiles.some((profile) => profile.id === value) ? (
            <NativeSelectOption value={value}>
              {selected?.name ?? t`Unavailable profile`}
            </NativeSelectOption>
          ) : null}
          {profiles.map((profile) => (
            <NativeSelectOption key={profile.id} value={profile.id}>
              {profile.name} · {harnessLabels[profile.harness]} · v{profile.revision}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {loadError ? (
        <div role="alert" className="mt-2 text-[13px] text-destructive">
          <Trans>Could not load execution profiles</Trans>{" "}
          <Button variant="link" size="sm" onClick={() => setRefresh((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {selected ? (
        <div data-testid="execution-profile-effective" className="mt-3 text-[13px]">
          <dl className="space-y-1">
            {[
              [t`Harness`, `${harnessLabels[selected.harness]} · ${selected.runtimeVersion}`],
              [t`Provider`, selected.provider],
              [t`Protocol`, selected.protocol],
              [t`Model`, selected.modelId],
              [t`Account`, account?.label ?? (loaded ? t`Unavailable account` : t`Loading…`)],
              [t`Environment`, selected.computerId ? t`Pinned computer` : t`Bot computer`],
              ...(selected.endpoint ? [[t`Endpoint`, selected.endpoint]] : []),
            ].map(([label, detail]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{detail}</dd>
              </div>
            ))}
          </dl>
          {unsupportedVersion ? (
            <div className="mt-2">
              <p role="alert" className="text-destructive">
                <Trans>Unsupported runtime version. Create a new revision.</Trans>
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={!loaded || pending}
                onClick={() => {
                  setName(selected.name);
                  setHarness(selected.harness);
                  setProtocol(selected.protocol);
                  setProvider(selected.provider);
                  setCredentialId(selected.credentialId);
                  setEndpoint(selected.endpoint ?? "");
                  setModelId(selected.modelId);
                  setInputModalities([]);
                  setSupersedesId(selected.id);
                  setError(null);
                  setCreating(true);
                }}
              >
                <Trans>New revision</Trans>
              </Button>
            </div>
          ) : null}
          {selected.harness !== "pi" &&
          NATIVE_EXECUTION_CAPABILITIES.requiresRestrictedLinuxDocker ? (
            <p className="mt-2 text-muted-foreground">
              <Trans>Requires an enabled Linux Docker runtime.</Trans>
            </p>
          ) : null}
          {unsupportedInputs ? (
            <p className="mt-1 text-muted-foreground">{t`Unavailable: ${unsupportedInputs}`}</p>
          ) : null}
          {undeclaredInputs ? (
            <p className="mt-1 text-muted-foreground">
              {t`Not enabled for this model: ${undeclaredInputs}`}
            </p>
          ) : null}
          {nativeProfile && !nativeProfile.inputModalities?.includes("audio") ? (
            <p className="mt-1 text-muted-foreground">
              <Trans>Live calls use transcripts.</Trans>
            </p>
          ) : null}
          {loaded && !account?.hasKey ? (
            <p role="alert" className="text-destructive">
              <Trans>This profile’s account is unavailable. Choose another profile.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {value && !selected && loaded ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          <Trans>This profile is unavailable. Choose another profile.</Trans>
        </p>
      ) : null}
      {!creating ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ms-2.5"
          disabled={!loaded}
          onClick={() => setCreating(true)}
        >
          <Trans>New profile</Trans>
        </Button>
      ) : (
        <div
          data-testid="execution-profile-create"
          className="mt-3 rounded-lg border border-border p-3"
        >
          <fieldset disabled={pending}>
            <label htmlFor={`${ids}-name`} className={fieldClass}>
              <Trans>Profile name</Trans>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5"
              />
            </label>
            <label htmlFor={`${ids}-harness`} className={fieldClass}>
              <Trans>Harness</Trans>
              <NativeSelect
                id={`${ids}-harness`}
                className="mt-1.5 w-full"
                value={harness}
                onChange={(event) => {
                  const next = event.target.value as Harness;
                  setHarness(next);
                  setProtocol(EXECUTION_HARNESS_PROTOCOLS[next][0]);
                  setProvider("");
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                {Object.entries(harnessLabels).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-version`} className={fieldClass}>
              <Trans>Runtime version</Trans>
              <Input
                id={`${ids}-version`}
                value={runtimeVersion}
                readOnly
                className="mt-1.5"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label htmlFor={`${ids}-provider`} className={fieldClass}>
              <Trans>Provider</Trans>
              <NativeSelect
                id={`${ids}-provider`}
                className="mt-1.5 w-full"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                <NativeSelectOption value="">{t`Choose provider`}</NativeSelectOption>
                {providers.map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {entry}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-protocol`} className={fieldClass}>
              <Trans>Protocol</Trans>
              <NativeSelect
                id={`${ids}-protocol`}
                className="mt-1.5 w-full"
                value={protocol}
                onChange={(event) => {
                  setProtocol(event.target.value as Protocol);
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                {EXECUTION_HARNESS_PROTOCOLS[harness].map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {entry}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-account`} className={fieldClass}>
              <Trans>Account</Trans>
              <NativeSelect
                id={`${ids}-account`}
                className="mt-1.5 w-full"
                value={credentialId}
                onChange={(event) => {
                  const next = accounts.find((account) => account.id === event.target.value);
                  setCredentialId(event.target.value);
                  setEndpoint(next?.baseUrl ?? "");
                  setModelId(next?.modelId ?? "");
                  setInputModalities([]);
                }}
              >
                <NativeSelectOption value="">{t`Choose account`}</NativeSelectOption>
                {accounts.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            {!availableCredentials.length ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                <Trans>Connect an API account in Models first.</Trans>
              </p>
            ) : null}
            <label htmlFor={`${ids}-model`} className={fieldClass}>
              <Trans>Model</Trans>
              <Input
                id={`${ids}-model`}
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setInputModalities([]);
                }}
                className="mt-1.5"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label htmlFor={`${ids}-endpoint`} className={fieldClass}>
              {harness === "pi" ? t`Endpoint (optional)` : t`Endpoint`}
              <Input
                id={`${ids}-endpoint`}
                value={endpoint}
                type="url"
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  setInputModalities([]);
                }}
                className="mt-1.5"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            {harness !== "pi" && modelId.trim()
              ? creatableInputs.map((kind) => (
                  <label
                    key={kind}
                    htmlFor={`${ids}-input-${kind}`}
                    className="mt-3 flex items-center justify-between gap-3 text-[13px]"
                  >
                    {kind === "image" ? t`Model accepts images` : t`Model accepts uploaded audio`}
                    <Switch
                      id={`${ids}-input-${kind}`}
                      aria-label={
                        kind === "image" ? t`Model accepts images` : t`Model accepts uploaded audio`
                      }
                      checked={inputModalities.includes(kind)}
                      onCheckedChange={(checked) =>
                        setInputModalities((current) =>
                          checked ? [...current, kind] : current.filter((entry) => entry !== kind),
                        )
                      }
                    />
                  </label>
                ))
              : null}
            <p className="mt-3 text-[13px] text-muted-foreground">
              <Trans>Environment: Bot computer</Trans>
            </p>
          </fieldset>
          {error ? (
            <p role="alert" className="mt-2 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={!canCreate || pending} onClick={() => void createProfile()}>
              <Trans>Create profile</Trans>
            </Button>
            <Button variant="ghost" disabled={pending} onClick={resetForm}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
