import { useEffect, useRef, useState } from "react";
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { BigShoulders_800ExtraBold } from "@expo-google-fonts/big-shoulders";
import { InstrumentSans_400Regular, InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans";
import Svg, { Path } from "react-native-svg";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { api } from "../../convex/_generated/api";
import { useColors } from "./src/theme";
import { AuthScreen, AuthStuckScreen } from "./src/AuthScreen";
import { ProfileScreen } from "./src/ProfileScreen";
import { TipsScreen } from "./src/TipsScreen";
import { CrewScreen, useInCrew } from "./src/CrewScreen";
import { EarningsScreen } from "./src/EarningsScreen";
import { Avatar, Banner, Body, Btn, ConnectionBar, DemoBar, ErrorBoundary, FONT, Loading, Row, Success, Title, announce } from "./src/ui";

SplashScreen.preventAutoHideAsync();

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, { unsavedChangesWarning: false });

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ BigShoulders_800ExtraBold, InstrumentSans_400Regular, InstrumentSans_600SemiBold });
  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);
  if (!fontsLoaded && !fontError) return null;
  return (
    <SafeAreaProvider>
      <ClerkProvider publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!} tokenCache={tokenCache}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          <ErrorBoundary>
            <Root />
          </ErrorBoundary>
        </ConvexProviderWithClerk>
      </ClerkProvider>
    </SafeAreaProvider>
  );
}

type Tab = "tips" | "crew" | "earn";
const TABS: [Tab, string, string][] = [
  ["tips", "Tips", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm3 6.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 2 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5V8m0 8v1.5"],
  ["crew", "Crew", "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 8c0-3 2.7-5 6-5s6 2 6 5m1-8a3 3 0 0 0 0-6m2 9c2 .6 3 2.2 3 5"],
  ["earn", "Earnings", "M5 20v-6m7 6V9m7 11V4"],
];

function Root() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isSignedIn } = useAuth();
  const me = useQuery(api.workers.me, isAuthenticated ? {} : "skip");
  const inCrew = useInCrew(isAuthenticated);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [tab, setTab] = useState<Tab>("tips");
  const [editing, setEditing] = useState(false);
  const [askJoin, setAskJoin] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [tipFlow, setTipFlow] = useState(false);
  const [notice, setNotice] = useState("");

  // None of this may carry over to whoever signs in next on this phone.
  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    setTab("tips");
    setEditing(false);
    setAskJoin(false);
    setDeclined(false);
    setTipFlow(false);
    setNotice("");
  }, [isLoading, isAuthenticated]);

  // One ScrollView hosts every screen, so a new screen shouldn't open at the old one's offset.
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [tab, editing, tipFlow]);

  useEffect(() => {
    if (!notice) return;
    announce(notice);
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  // Android's back button walks back through the app instead of leaving it. TipsScreen handles its own steps.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!isAuthenticated || tipFlow) return false;
      if (editing && me?.worker) { setEditing(false); return true; }
      if (tab !== "tips") { setTab("tips"); return true; }
      return false;
    });
    return () => sub.remove();
  }, [isAuthenticated, tipFlow, editing, tab, me?.worker]);

  let content: React.ReactNode;
  let signedInApp = false;
  if (isLoading || (isAuthenticated && me === undefined)) content = <Loading />;
  else if (!isAuthenticated) content = isSignedIn ? <AuthStuckScreen /> : <AuthScreen />;
  else if (!me?.worker || editing)
    content = <ProfileScreen initial={me?.worker ?? undefined} onDone={() => { setEditing(false); setNotice("Profile saved"); }} onCancel={me?.worker ? () => setEditing(false) : undefined} />;
  else {
    signedInApp = true;
    const w = me.worker;
    content = (
      <View style={{ gap: 18, flex: 1 }}>
        {!tipFlow && (
          <Row style={{ justifyContent: "space-between" }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${w.name}, edit profile`} onPress={() => setEditing(true)} style={({ pressed }) => ({ flexShrink: 1, minHeight: 44, justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
              <Row><Avatar name={w.name} /><Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONT.bodyBold, color: c.ink }}>{w.name}</Text></Row>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={inCrew ? "In a crew today, open crew" : "Solo today, open crew"} onPress={() => setTab("crew")} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", backgroundColor: c.sunk, borderRadius: 999, paddingHorizontal: 12, opacity: pressed ? 0.7 : 1 })}>
              <Row style={{ gap: 6 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: inCrew ? c.good : c.control }} />
                <Text maxFontSizeMultiplier={1.4} style={{ color: c.ink, fontSize: 12, fontFamily: FONT.bodyBold }}>{inCrew ? "In crew" : "Solo today"}</Text>
              </Row>
            </Pressable>
          </Row>
        )}
        {!!notice && !tipFlow && <Success>{notice}</Success>}
        {askJoin && inCrew === false && !tipFlow && (
          <Banner>
            <Title>Join today's crew?</Title>
            <Body>Pool tips with the people you're working with. Tips you already got stay yours.</Body>
            <Btn kind="primary" title="Join or start a crew" onPress={() => { setAskJoin(false); setTab("crew"); }} />
            <Btn kind="ghost" title="Not today" onPress={() => { setAskJoin(false); setDeclined(true); }} />
          </Banner>
        )}
        {tab === "tips" && <TipsScreen handle={w.handle} name={w.name} inCrew={!!inCrew} onFlowChange={setTipFlow} onTipped={() => { if (inCrew === false && !declined) setAskJoin(true); }} />}
        {tab === "crew" && <CrewScreen />}
        {tab === "earn" && <EarningsScreen />}
      </View>
    );
  }
  const showTabs = signedInApp && !tipFlow;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      <StatusBar style="auto" />
      <DemoBar />
      <ConnectionBar />
      {/* iOS has the ScrollView lift the focused field itself; KeyboardAvoidingView covers Android's edge-to-edge window. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "android" ? "padding" : undefined}>
        <ScrollView ref={scroll} automaticallyAdjustKeyboardInsets contentContainerStyle={{ padding: 18, paddingBottom: showTabs ? 18 : 18 + insets.bottom, gap: 18, flexGrow: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}>
          {!signedInApp && <Text accessibilityRole="header" maxFontSizeMultiplier={1.5} style={{ fontSize: 26, fontFamily: FONT.display, color: c.ink, textTransform: "uppercase" }}>Tip Jar</Text>}
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
      {showTabs && (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.line }}>
          <View accessibilityRole="tablist" style={{ flexDirection: "row" }}>
            {TABS.map(([k, l, d]) => {
              const on = tab === k;
              return (
                <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(k)} style={({ pressed }) => ({ flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 2, paddingVertical: 6, borderTopWidth: 2, borderTopColor: on ? c.green : "transparent", opacity: pressed ? 0.7 : 1 })}>
                  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={on ? c.green : c.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d={d} /></Svg>
                  <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontSize: 12, fontFamily: FONT.bodyBold, color: on ? c.green : c.muted }}>{l}</Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}
