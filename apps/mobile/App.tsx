import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { BigShoulders_800ExtraBold } from "@expo-google-fonts/big-shoulders";
import { InstrumentSans_400Regular, InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans";
import { DMMono_400Regular } from "@expo-google-fonts/dm-mono";
import Svg, { Path } from "react-native-svg";
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
import { Avatar, Banner, Body, Btn, DemoBar, FONT, Row, Title } from "./src/ui";

SplashScreen.preventAutoHideAsync();

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, { unsavedChangesWarning: false });

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ BigShoulders_800ExtraBold, InstrumentSans_400Regular, InstrumentSans_600SemiBold, DMMono_400Regular });
  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);
  if (!fontsLoaded && !fontError) return null;
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
const TABS: [Tab, string, string][] = [
  ["tips", "Tips", "M4 8h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Zm2-4h12l2 4H4l2-4Zm6 8v4m-2-2h4"],
  ["crew", "Crew", "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 8c0-3 2.7-5 6-5s6 2 6 5m1-8a3 3 0 0 0 0-6m2 9c2 .6 3 2.2 3 5"],
  ["earn", "Earnings", "M5 20v-6m7 6V9m7 11V4"],
];

function Root() {
  const c = useColors();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const inCrew = useInCrew();
  const [tab, setTab] = useState<Tab>("tips");
  const [editing, setEditing] = useState(false);
  const [askJoin, setAskJoin] = useState(false);
  const [declined, setDeclined] = useState(false);

  let content: React.ReactNode;
  let showTabs = false;
  if (isLoading || (isAuthenticated && me === undefined)) content = <Body muted>Loading…</Body>;
  else if (!isAuthenticated) content = <AuthScreen />;
  else if (!me?.worker || editing)
    content = <ProfileScreen initial={me?.worker ?? undefined} onDone={() => setEditing(false)} onCancel={me?.worker ? () => setEditing(false) : undefined} />;
  else {
    showTabs = true;
    const w = me.worker;
    content = (
      <View style={{ gap: 18, flex: 1 }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={() => setEditing(true)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Row><Avatar name={w.name} /><Text style={{ fontFamily: FONT.bodyBold, color: c.ink }}>{w.name}</Text></Row>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setTab("crew")} style={{ minHeight: 44, justifyContent: "center", backgroundColor: c.brassSoft, borderRadius: 999, paddingHorizontal: 12 }}>
            <Row style={{ gap: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: inCrew ? c.good : c.control }} />
              <Text style={{ color: c.ink, fontSize: 12, fontFamily: FONT.bodyBold }}>{inCrew ? "In crew" : "Solo today"}</Text>
            </Row>
          </Pressable>
        </Row>
        {askJoin && (
          <Banner>
            <Title>Join today's crew?</Title>
            <Body>Pool tips with the people you're working with. Tips you already got stay yours.</Body>
            <Btn kind="primary" title="Join or start a crew" onPress={() => { setAskJoin(false); setTab("crew"); }} />
            <Btn kind="ghost" title="Not today" onPress={() => { setAskJoin(false); setDeclined(true); }} />
          </Banner>
        )}
        {tab === "tips" && <TipsScreen handle={w.handle} name={w.name} onTipped={() => { if (inCrew === false && !declined) setAskJoin(true); }} />}
        {tab === "crew" && <CrewScreen />}
        {tab === "earn" && <EarningsScreen />}
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      <StatusBar style="auto" />
      <DemoBar />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 18, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {!showTabs && <Text accessibilityRole="header" style={{ fontSize: 26, fontFamily: FONT.display, color: c.ink, textTransform: "uppercase" }}>Tip Jar</Text>}
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
      {showTabs && (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.line }}>
          <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 4 }}>
            {TABS.map(([k, l, d]) => {
              const on = tab === k;
              return (
                <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(k)} style={{ flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 2 }}>
                  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={on ? c.green : c.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d={d} /></Svg>
                  <Text style={{ fontSize: 12, fontFamily: FONT.bodyBold, color: on ? c.green : c.muted }}>{l}</Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}
