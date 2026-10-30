import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { api } from "../../convex/_generated/api";
import { useColors } from "./src/theme";
import { AuthScreen } from "./src/AuthScreen";
import { ProfileScreen } from "./src/ProfileScreen";
import { TipsScreen } from "./src/TipsScreen";
import { CrewScreen, useInCrew } from "./src/CrewScreen";
import { EarningsScreen } from "./src/EarningsScreen";
import { Avatar, Body, Btn, Card, Row, Title } from "./src/ui";

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, { unsavedChangesWarning: false });

export default function App() {
  return (
    <SafeAreaProvider>
      <ClerkProvider publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!} tokenCache={tokenCache}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <Root />
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </SafeAreaProvider>
  );
}

type Tab = "tips" | "crew" | "earn";

function Root() {
  const c = useColors();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const inCrew = useInCrew();
  const { signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("tips");
  const [editing, setEditing] = useState(false);
  const [askJoin, setAskJoin] = useState(false);
  const [declined, setDeclined] = useState(false);

  let content: React.ReactNode;
  let showTabs = false;
  if (isLoading || (isAuthenticated && me === undefined)) content = <Body muted>Loading…</Body>;
  else if (!isAuthenticated) content = <AuthScreen />;
  else if (!me?.worker || editing)
    content = (
      <View style={{ gap: 10 }}>
        <ProfileScreen initial={me?.worker ?? undefined} onDone={() => setEditing(false)} />
        <Btn kind="ghost" title={me?.worker ? "Cancel" : "Sign out"} onPress={() => (me?.worker ? setEditing(false) : signOut())} />
      </View>
    );
  else {
    showTabs = true;
    const w = me.worker;
    content = (
      <View style={{ gap: 18, flex: 1 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pressable onPress={() => setEditing(true)} accessibilityLabel="Edit profile"><Row><Avatar name={w.name} /><Text style={{ fontWeight: "700", color: c.ink }}>{w.name}</Text></Row></Pressable>
          <Pressable onPress={() => signOut()}><Text style={{ color: c.muted }}>Sign out</Text></Pressable>
        </Row>
        {askJoin && (
          <Card style={{ backgroundColor: c.brassSoft, borderColor: c.brassSoft }}>
            <Title>Join today's crew?</Title>
            <Body>Pool tips with the people you're working with. Tips you already got stay yours.</Body>
            <Btn kind="primary" title="Join or start a crew" onPress={() => { setAskJoin(false); setTab("crew"); }} />
            <Btn kind="ghost" title="Not today" onPress={() => { setAskJoin(false); setDeclined(true); }} />
          </Card>
        )}
        {tab === "tips" && <TipsScreen onTipped={() => { if (inCrew === false && !declined) setAskJoin(true); }} />}
        {tab === "crew" && <CrewScreen />}
        {tab === "earn" && <EarningsScreen />}
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      <StatusBar style="auto" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 18, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {!showTabs && <Text style={{ fontSize: 26, fontWeight: "900", color: c.ink, textTransform: "uppercase" }}>Tip Jar</Text>}
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
      {showTabs && (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.line }}>
          <View style={{ flexDirection: "row", padding: 6 }}>
            {([["tips", "Tips"], ["crew", "Crew"], ["earn", "Earnings"]] as [Tab, string][]).map(([k, l]) => (
              <Pressable key={k} onPress={() => setTab(k)} style={{ flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: 12, backgroundColor: tab === k ? c.green : "transparent" }}>
                <Text style={{ fontWeight: "700", color: tab === k ? c.greenInk : c.muted }}>{l}</Text>
              </Pressable>
            ))}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}
