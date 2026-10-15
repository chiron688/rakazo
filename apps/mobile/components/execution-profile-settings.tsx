import type { ExecutionInputModality, ExecutionProfile, ModelCredential } from "@rakazo/contracts";
import {
  CreateExecutionProfileInput,
  EXECUTION_HARNESS_PROTOCOLS,
  EXECUTION_HARNESS_VERSIONS,
  NATIVE_EXECUTION_CAPABILITIES,
  supportedExecutionInputModalities,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

type Harness = ExecutionProfile["harness"];
type Protocol = ExecutionProfile["protocol"];
const harnessLabels: Record<Harness, string> = {
  pi: "Pi",
  claude: "Claude Agent",
  codex: "Codex",
  kimi: "Kimi Code",
};

export function ExecutionProfileSettings({
  value,
  currentProfile,
  onChange,
}: {
  value: string | null;
  currentProfile?: ExecutionProfile | null;
  onChange: (profileId: string | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
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
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoaded(false);
    setLoadError(false);
    void Promise.all([
      rpc<ExecutionProfile[]>("executionProfiles/list"),
      rpc<ModelCredential[]>("models/credentials"),
    ])
      .then(([nextProfiles, nextCredentials]) => {
        if (!current) return;
        setProfiles(nextProfiles);
        setCredentials(nextCredentials);
        setLoaded(true);
      })
      .catch(() => {
        if (current) setLoadError(true);
      });
    return () => {
      current = false;
    };
  }, [refresh]);

  const selected =
    profiles.find((profile) => profile.id === value) ??
    (currentProfile?.id === value ? currentProfile : undefined);
  const nativeProfile = selected?.harness !== "pi" ? selected : undefined;
  const unsupportedVersion =
    selected && selected.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[selected.harness];
  const transportInputs = nativeProfile ? supportedExecutionInputModalities(nativeProfile) : [];
  const inputLabels = { image: t("image input"), audio: t("uploaded audio") };
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
  const canCreate = Boolean(
    loaded &&
      name.trim() &&
      runtimeVersion.trim() &&
      provider &&
      chosenAccount &&
      modelId.trim() &&
      (harness === "pi" || endpoint.trim()),
  );
  const choices = [
    { key: "", label: t("Pi (default)") },
    ...(value && !profiles.some((profile) => profile.id === value)
      ? [{ key: value, label: selected?.name ?? t("Unavailable profile") }]
      : []),
    ...profiles.map((profile) => ({
      key: profile.id,
      label: `${profile.name} · ${harnessLabels[profile.harness]} · v${profile.revision}`,
    })),
  ];

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
      setError(parsed.error.issues[0]?.message ?? t("Check the profile fields"));
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const profile = await rpc<ExecutionProfile>("executionProfiles/create", parsed.data);
      if (!active.current) return;
      setProfiles((current) => [...current, profile]);
      onChange(profile.id);
      resetForm();
    } catch (err) {
      if (active.current) setError(errorText(err, t("Could not create profile")));
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  }

  const inputStyle = {
    color: tokens.foreground,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 44,
    fontSize: 16,
  };
  const detailStyle = { color: tokens.mutedForeground, fontSize: 13, marginTop: 8 };
  function field(label: string, child: ReactNode) {
    return (
      <View style={{ gap: 6, marginTop: 12 }}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{label}</Text>
        {child}
      </View>
    );
  }

  return (
    <View testID="execution-profile-settings" style={{ marginTop: 8 }}>
      <View
        pointerEvents={pending ? "none" : "auto"}
        style={{ borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" }}
      >
        <MenuPicker
          label={t("Execution profile")}
          choices={choices}
          value={value ?? ""}
          onChange={(key) => {
            if (!pendingRef.current) onChange(key || null);
          }}
        />
      </View>
      {loadError ? (
        <>
          <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
            {t("Could not load execution profiles")}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            prominence="plain"
            onPress={() => setRefresh((value) => value + 1)}
          />
        </>
      ) : null}
      {selected ? (
        <View testID="execution-profile-effective">
          {[
            [t("Harness"), `${harnessLabels[selected.harness]} · ${selected.runtimeVersion}`],
            [t("Provider"), selected.provider],
            [t("Protocol"), selected.protocol],
            [t("Model"), selected.modelId],
            [t("Account"), account?.label ?? (loaded ? t("Unavailable account") : t("Loading…"))],
            [t("Environment"), selected.computerId ? t("Pinned computer") : t("Bot computer")],
            ...(selected.endpoint ? [[t("Endpoint"), selected.endpoint]] : []),
          ].map(([label, detail]) => (
            <Text key={label} style={detailStyle}>
              {label}: {detail}
            </Text>
          ))}
          {unsupportedVersion ? (
            <>
              <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
                {t("Unsupported runtime version. Create a new revision.")}
              </Text>
              <NativeActionButton
                label={t("New revision")}
                prominence="plain"
                disabled={!loaded || pending}
                onPress={() => {
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
              />
            </>
          ) : null}
          {selected.harness !== "pi" &&
          NATIVE_EXECUTION_CAPABILITIES.requiresRestrictedLinuxDocker ? (
            <Text style={detailStyle}>{t("Requires an enabled Linux Docker runtime.")}</Text>
          ) : null}
          {unsupportedInputs ? (
            <Text style={detailStyle}>
              {t("Unavailable: {capabilities}", { capabilities: unsupportedInputs })}
            </Text>
          ) : null}
          {undeclaredInputs ? (
            <Text style={detailStyle}>
              {t("Not enabled for this model: {capabilities}", { capabilities: undeclaredInputs })}
            </Text>
          ) : null}
          {nativeProfile && !nativeProfile.inputModalities?.includes("audio") ? (
            <Text style={detailStyle}>{t("Live calls use transcripts.")}</Text>
          ) : null}
          {loaded && !account?.hasKey ? (
            <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
              {t("This profile’s account is unavailable. Choose another profile.")}
            </Text>
          ) : null}
        </View>
      ) : null}
      {value && !selected && loaded ? (
        <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
          {t("This profile is unavailable. Choose another profile.")}
        </Text>
      ) : null}
      {!creating ? (
        <NativeActionButton
          label={t("New profile")}
          prominence="plain"
          disabled={!loaded}
          onPress={() => setCreating(true)}
        />
      ) : (
        <View testID="execution-profile-create">
          <View pointerEvents={pending ? "none" : "auto"}>
            {field(
              t("Profile name"),
              <TextInput
                accessibilityLabel={t("Profile name")}
                style={inputStyle}
                value={name}
                maxLength={80}
                onChangeText={setName}
                editable={!pending}
              />,
            )}
            <MenuPicker
              label={t("Harness")}
              value={harness}
              choices={Object.entries(harnessLabels).map(([key, label]) => ({ key, label }))}
              onChange={(key) => {
                const next = key as Harness;
                setHarness(next);
                setProtocol(EXECUTION_HARNESS_PROTOCOLS[next][0]);
                setProvider("");
                setCredentialId("");
                setEndpoint("");
                setModelId("");
                setInputModalities([]);
              }}
            />
            {field(
              t("Runtime version"),
              <TextInput
                accessibilityLabel={t("Runtime version")}
                style={inputStyle}
                value={runtimeVersion}
                editable={false}
              />,
            )}
            <MenuPicker
              label={t("Provider")}
              value={provider}
              choices={[
                { key: "", label: t("Choose provider") },
                ...providers.map((key) => ({ key, label: key })),
              ]}
              onChange={(key) => {
                setProvider(key);
                setCredentialId("");
                setEndpoint("");
                setModelId("");
                setInputModalities([]);
              }}
            />
            <MenuPicker
              label={t("Protocol")}
              value={protocol}
              choices={EXECUTION_HARNESS_PROTOCOLS[harness].map((key) => ({ key, label: key }))}
              onChange={(key) => {
                setProtocol(key as Protocol);
                setCredentialId("");
                setEndpoint("");
                setModelId("");
                setInputModalities([]);
              }}
            />
            <MenuPicker
              label={t("Account")}
              value={credentialId}
              choices={[
                { key: "", label: t("Choose account") },
                ...accounts.map((account) => ({ key: account.id, label: account.label })),
              ]}
              onChange={(key) => {
                const next = accounts.find((account) => account.id === key);
                setCredentialId(key);
                setEndpoint(next?.baseUrl ?? "");
                setModelId(next?.modelId ?? "");
                setInputModalities([]);
              }}
            />
            {!availableCredentials.length ? (
              <Text style={detailStyle}>{t("Connect an API account in Models first.")}</Text>
            ) : null}
            {field(
              t("Model"),
              <TextInput
                accessibilityLabel={t("Model")}
                style={inputStyle}
                value={modelId}
                onChangeText={(value) => {
                  setModelId(value);
                  setInputModalities([]);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
              />,
            )}
            {field(
              harness === "pi" ? t("Endpoint (optional)") : t("Endpoint"),
              <TextInput
                accessibilityLabel={harness === "pi" ? t("Endpoint (optional)") : t("Endpoint")}
                style={inputStyle}
                value={endpoint}
                onChangeText={(value) => {
                  setEndpoint(value);
                  setInputModalities([]);
                }}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
              />,
            )}
            {harness !== "pi" && modelId.trim()
              ? creatableInputs.map((kind) => {
                  const label =
                    kind === "image"
                      ? t("Model accepts images")
                      : t("Model accepts uploaded audio");
                  return (
                    <View
                      key={kind}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <Text style={{ ...detailStyle, flex: 1 }}>{label}</Text>
                      <NativeSwitch
                        accessibilityLabel={label}
                        value={inputModalities.includes(kind)}
                        disabled={pending}
                        onValueChange={(checked) =>
                          setInputModalities((current) =>
                            checked
                              ? [...current, kind]
                              : current.filter((entry) => entry !== kind),
                          )
                        }
                      />
                    </View>
                  );
                })
              : null}
            <Text style={detailStyle}>{t("Environment: Bot computer")}</Text>
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
              {error}
            </Text>
          ) : null}
          <NativeActionButton
            label={t("Create profile")}
            disabled={!canCreate || pending}
            busy={pending}
            onPress={() => void createProfile()}
            style={{ marginTop: 16 }}
          />
          <NativeActionButton
            label={t("Cancel")}
            prominence="plain"
            disabled={pending}
            onPress={resetForm}
          />
        </View>
      )}
    </View>
  );
}
