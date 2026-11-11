import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../localization";
import { radius, space, type, useTheme } from "../theme/tokens";
import { useReducedMotion } from "./motion";
import { Icon } from "./icons";
import {
  INTRO_FIRST_MS, INTRO_STAGE_MS, introDurationFor, type IntroMode,
} from "../services/intro";

const NATIVE_DRIVER = Platform.OS !== "web";
const GLOW = "rgba(45,212,191,0.14)";
const GLOW_SOFT = "rgba(45,212,191,0.07)";
const HAIRLINE = "rgba(255,255,255,0.12)";
const CARD = "rgba(6,30,28,0.74)";
const TRACK = "rgba(255,255,255,0.16)";
const CAPTION = "#D7E3EC";

/** The illustration is drawn once in this coordinate space, then scaled to the real screen. */
const SCENE_W = 360;
const SCENE_H = 220;
const SCENE_RATIO = SCENE_W / SCENE_H;

const SHOP = {
  wall: "#F3E7D3", wallLine: "#E7D5BB", floor: "#D9BE9A", floorLine: "#C6A57C",
  frame: "#6D4832", frameDark: "#543522", wood: "#8D5B3B", woodDark: "#70442B",
  shelfBack: "#EAD8BB", shelfSide: "#7A4E33", board: "#8B5A39",
  rice: "#F8EFDA", riceEdge: "#E3CEAA", gold: "#D8A43D",
  bottle: "#2D8F83", bottleDark: "#1E6C62", carton: "#C77A3B", cartonTape: "#E9B873",
  paper: "#F7ECD8", ink: "#24352F", skin: "#8B5A37", hair: "#2E211B",
  apron: "#0F766E", apronLight: "#2DD4BF", shirt: "#E9DDC9", pants: "#33415C",
  customer: "#B45309", plant: "#3F7D52", pot: "#A45C3A", sky: "#CBE8E2",
  skyDeep: "#AEDBD4", ground: "#A9C79B", sun: "#F4C766", white: "#FFFDF7",
} as const;

const at = (ms: number) => ms / INTRO_FIRST_MS;

const fade = (value: Animated.Value, start: number, inEnd: number, outStart: number, outEnd: number) =>
  value.interpolate({
    inputRange: [start, inEnd, outStart, outEnd],
    outputRange: [0, 1, 1, 0],
    extrapolate: "clamp",
  });

const grow = (value: Animated.Value, start: number, end: number) =>
  value.interpolate({ inputRange: [start, end], outputRange: [0, 1], extrapolate: "clamp" });

function BrandMark({ size = 40, accent, ink }: { size?: number; accent: string; ink: string }) {
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.28, backgroundColor: accent,
      alignItems: "center", justifyContent: "center",
      shadowColor: accent, shadowOpacity: 0.38, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4,
    }}>
      <Icon name="box" size={size * 0.52} color={ink} strokeWidth={1.8} />
    </View>
  );
}

function BrandLockup({ compact = false }: { compact?: boolean }) {
  const c = useTheme();
  const t = useT();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 10 : 13 }}>
      <BrandMark size={compact ? 34 : 44} accent={c.sidebarIndicator} ink={c.sidebar} />
      <View style={{ gap: compact ? 0 : 2 }}>
        <Text style={{ color: c.sidebarInk, fontSize: compact ? 18 : 22, lineHeight: compact ? 22 : 27, fontWeight: "800", letterSpacing: -0.4 }}>
          {t("app.name")}
        </Text>
        <Text numberOfLines={1} style={{ color: c.sidebarMuted, fontSize: compact ? 10 : 12, lineHeight: compact ? 13 : 16, fontWeight: "500" }}>
          {t("brand.tagline")}
        </Text>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Shop illustration primitives. Everything is a plain View so the intro stays offline, sharp at
 * every density, and cheap enough to animate on the Infinix-class phones this app targets.
 * ---------------------------------------------------------------------------------------------- */

function Product({ kind, w = 22, h = 24 }: { kind: "rice" | "bottle" | "carton"; w?: number; h?: number }) {
  if (kind === "bottle") {
    return (
      <View style={{ width: w, height: h, alignItems: "center", justifyContent: "flex-end" }}>
        <View style={{ position: "absolute", top: 0, width: w * 0.34, height: h * 0.12, borderRadius: 1, backgroundColor: SHOP.bottleDark }} />
        <View style={{ position: "absolute", top: h * 0.1, width: w * 0.42, height: h * 0.17, backgroundColor: SHOP.bottleDark }} />
        <View style={{ position: "absolute", top: h * 0.24, width: w * 0.74, height: h * 0.76, borderRadius: w * 0.14, backgroundColor: SHOP.bottle }} />
        <View style={{ position: "absolute", top: h * 0.52, width: w * 0.62, height: h * 0.24, borderRadius: 1, backgroundColor: SHOP.paper }} />
        <View style={{ position: "absolute", top: h * 0.6, width: w * 0.4, height: 1.4, backgroundColor: SHOP.bottleDark, opacity: 0.55 }} />
      </View>
    );
  }
  if (kind === "carton") {
    return (
      <View style={{ width: w, height: h, borderRadius: 2, backgroundColor: SHOP.carton, overflow: "hidden", borderWidth: 0.7, borderColor: "rgba(84,53,34,0.28)" }}>
        <View style={{ position: "absolute", left: w * 0.42, top: 0, width: w * 0.16, height: h, backgroundColor: SHOP.cartonTape, opacity: 0.92 }} />
        <View style={{ position: "absolute", left: w * 0.14, top: h * 0.42, width: w * 0.25, height: h * 0.3, borderRadius: 1, backgroundColor: SHOP.paper, opacity: 0.92 }} />
        <View style={{ position: "absolute", left: w * 0.18, top: h * 0.51, width: w * 0.17, height: 1.3, backgroundColor: SHOP.carton, opacity: 0.7 }} />
      </View>
    );
  }
  return (
    <View style={{ width: w, height: h, alignItems: "center", justifyContent: "flex-end" }}>
      <View style={{ position: "absolute", top: 0, width: w * 0.34, height: h * 0.1, backgroundColor: SHOP.gold }} />
      <View style={{ position: "absolute", top: h * 0.08, width: w * 0.52, height: h * 0.1, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: SHOP.riceEdge }} />
      <View style={{
        position: "absolute", top: h * 0.15, width: w, height: h * 0.85, borderTopLeftRadius: w * 0.28,
        borderTopRightRadius: w * 0.28, borderBottomLeftRadius: 2, borderBottomRightRadius: 2,
        backgroundColor: SHOP.rice, borderWidth: 0.7, borderColor: SHOP.riceEdge, overflow: "hidden",
      }}>
        <View style={{ position: "absolute", top: h * 0.36, width: "100%", height: h * 0.13, backgroundColor: SHOP.gold, opacity: 0.92 }} />
        <View style={{ position: "absolute", top: h * 0.6, left: w * 0.2, width: w * 0.45, height: h * 0.1, borderRadius: 1, backgroundColor: SHOP.paper }} />
      </View>
    </View>
  );
}

function Shelf() {
  return (
    <>
      <View style={{
        position: "absolute", left: 196, top: 36, width: 152, height: 116, borderRadius: 3,
        backgroundColor: SHOP.shelfBack, borderWidth: 2, borderColor: SHOP.shelfSide,
      }}>
        <View style={{ position: "absolute", left: 4, top: 4, right: 4, bottom: 4, borderWidth: 1, borderColor: "rgba(84,53,34,0.18)" }} />
        <View style={{ position: "absolute", left: 8, top: 36, width: 136, height: 4, borderRadius: 1, backgroundColor: SHOP.board }} />
        <View style={{ position: "absolute", left: 8, top: 74, width: 136, height: 4, borderRadius: 1, backgroundColor: SHOP.board }} />
        <View style={{ position: "absolute", left: 4, top: 4, bottom: 4, width: 4, backgroundColor: SHOP.shelfSide }} />
        <View style={{ position: "absolute", right: 4, top: 4, bottom: 4, width: 4, backgroundColor: SHOP.shelfSide }} />
      </View>
      <View style={{ position: "absolute", left: 234, top: 51, width: 24, height: 23 }}><Product kind="bottle" w={13} h={23} /></View>
      <View style={{ position: "absolute", left: 251, top: 51, width: 24, height: 23 }}><Product kind="bottle" w={13} h={23} /></View>
      <View style={{ position: "absolute", left: 268, top: 49, width: 24, height: 25 }}><Product kind="rice" w={23} h={25} /></View>
      <View style={{ position: "absolute", left: 296, top: 49, width: 23, height: 25 }}><Product kind="carton" w={23} h={25} /></View>
      <View style={{ position: "absolute", left: 322, top: 51, width: 23, height: 23 }}><Product kind="bottle" w={13} h={23} /></View>

      <View style={{ position: "absolute", left: 204, top: 87, width: 23, height: 25 }}><Product kind="rice" w={23} h={25} /></View>
      <View style={{ position: "absolute", left: 258, top: 89, width: 23, height: 23 }}><Product kind="bottle" w={13} h={23} /></View>
      <View style={{ position: "absolute", left: 275, top: 87, width: 23, height: 25 }}><Product kind="carton" w={23} h={25} /></View>
    </>
  );
}

function Shopkeeper() {
  return (
    <View style={{ position: "absolute", left: 272, top: 76, width: 42, height: 76 }}>
      <View style={{ position: "absolute", left: 13, top: 2, width: 17, height: 17, borderRadius: 9, backgroundColor: SHOP.skin }} />
      <View style={{ position: "absolute", left: 12, top: 0, width: 19, height: 8, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.hair }} />
      <View style={{ position: "absolute", left: 17, top: 18, width: 9, height: 4, backgroundColor: SHOP.skin }} />
      <View style={{ position: "absolute", left: 8, top: 21, width: 26, height: 43, borderTopLeftRadius: 10, borderTopRightRadius: 10, backgroundColor: SHOP.shirt }} />
      <View style={{ position: "absolute", left: 11, top: 25, width: 20, height: 43, borderTopLeftRadius: 5, borderTopRightRadius: 5, backgroundColor: SHOP.apron }} />
      <View style={{ position: "absolute", left: 15, top: 35, width: 12, height: 12, borderRadius: 2, backgroundColor: SHOP.apronLight, opacity: 0.38 }} />
      <View style={{ position: "absolute", left: 3, top: 26, width: 6, height: 26, borderRadius: 3, backgroundColor: SHOP.shirt }} />
      <View style={{ position: "absolute", left: 34, top: 26, width: 6, height: 26, borderRadius: 3, backgroundColor: SHOP.shirt }} />
      <View style={{ position: "absolute", left: 2, top: 48, width: 8, height: 8, borderRadius: 4, backgroundColor: SHOP.skin }} />
      <View style={{ position: "absolute", left: 34, top: 48, width: 8, height: 8, borderRadius: 4, backgroundColor: SHOP.skin }} />
    </View>
  );
}

function Counter() {
  return (
    <View style={{ position: "absolute", left: 224, top: 144, width: 136, height: 62 }}>
      <View style={{ position: "absolute", left: 0, top: 0, width: 136, height: 8, borderRadius: 2, backgroundColor: "#C08A5E" }} />
      <View style={{ position: "absolute", left: 2, top: 8, width: 132, height: 50, backgroundColor: SHOP.wood }} />
      <View style={{ position: "absolute", left: 8, top: 14, width: 120, height: 38, borderWidth: 1.4, borderColor: "rgba(84,53,34,0.38)", borderRadius: 2 }} />
      <View style={{ position: "absolute", left: 65, top: 14, width: 1.4, height: 38, backgroundColor: "rgba(84,53,34,0.3)" }} />
      <View style={{ position: "absolute", left: 10, top: 18, width: 48, height: 3, borderRadius: 1, backgroundColor: "rgba(247,236,216,0.2)" }} />
      <View style={{ position: "absolute", left: 74, top: 18, width: 44, height: 3, borderRadius: 1, backgroundColor: "rgba(247,236,216,0.2)" }} />
      <View style={{ position: "absolute", right: 8, top: -9, width: 23, height: 10, borderRadius: 2, backgroundColor: SHOP.frameDark }} />
      <View style={{ position: "absolute", right: 12, top: -14, width: 12, height: 6, borderRadius: 1, backgroundColor: "#B9C4C1" }} />
    </View>
  );
}

function ShopBackdrop() {
  return (
    <View style={{ position: "absolute", left: 0, top: 0, width: SCENE_W, height: SCENE_H, backgroundColor: SHOP.wall, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 62, backgroundColor: SHOP.floor }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 157, height: 3, backgroundColor: SHOP.frame, opacity: 0.24 }} />
      {[24, 92, 158, 222, 292, 350].map((x) => (
        <View key={x} style={{ position: "absolute", left: x, top: 160, width: 1, height: 60, backgroundColor: SHOP.floorLine, opacity: 0.55 }} />
      ))}
      <View style={{ position: "absolute", left: 0, right: 0, top: 190, height: 1, backgroundColor: SHOP.floorLine, opacity: 0.55 }} />

      {/* Open shop entrance, with daylight and a small Idukaa sign above it. */}
      <View style={{ position: "absolute", left: 12, top: 31, width: 82, height: 132, borderRadius: 4, backgroundColor: SHOP.frame }}>
        <View style={{ position: "absolute", left: 5, top: 5, width: 70, height: 122, backgroundColor: SHOP.sky, overflow: "hidden" }}>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 40, backgroundColor: SHOP.ground }} />
          <View style={{ position: "absolute", right: 10, top: 18, width: 18, height: 18, borderRadius: 9, backgroundColor: SHOP.sun }} />
          <View style={{ position: "absolute", left: 8, top: 66, width: 60, height: 2, backgroundColor: SHOP.frame, opacity: 0.22 }} />
        </View>
        <View style={{ position: "absolute", left: 5, top: 63, width: 70, height: 3, backgroundColor: SHOP.frame, opacity: 0.5 }} />
        <View style={{ position: "absolute", left: 74, top: 5, width: 8, height: 122, backgroundColor: SHOP.frameDark }} />
        <View style={{ position: "absolute", right: -4, top: 5, width: 10, height: 122, borderWidth: 2, borderColor: SHOP.frameDark, backgroundColor: "rgba(247,236,216,0.1)" }} />
      </View>
      <View style={{
        position: "absolute", left: 12, top: 11, width: 82, height: 18, borderRadius: 2,
        backgroundColor: SHOP.frameDark, alignItems: "center", justifyContent: "center",
      }}>
        <Text style={{ color: SHOP.paper, fontSize: 8, lineHeight: 10, fontWeight: "800", letterSpacing: 1.1 }}>IDUKAA</Text>
      </View>

      {/* Window and a simple stock poster make this read as a retail shop, not a warehouse. */}
      <View style={{ position: "absolute", left: 112, top: 40, width: 67, height: 55, borderRadius: 2, backgroundColor: SHOP.frame, padding: 3 }}>
        <View style={{ flex: 1, backgroundColor: SHOP.skyDeep, overflow: "hidden" }}>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 18, backgroundColor: SHOP.ground }} />
          <View style={{ position: "absolute", left: 27, top: 0, width: 2, height: 40, backgroundColor: SHOP.frame, opacity: 0.5 }} />
          <View style={{ position: "absolute", left: 0, right: 0, top: 20, height: 2, backgroundColor: SHOP.frame, opacity: 0.5 }} />
        </View>
      </View>
      <View style={{ position: "absolute", left: 121, top: 105, width: 49, height: 42, borderRadius: 2, backgroundColor: SHOP.paper, borderWidth: 1, borderColor: SHOP.riceEdge }}>
        <View style={{ position: "absolute", left: 6, top: 6, width: 24, height: 2, backgroundColor: SHOP.ink, opacity: 0.55 }} />
        <View style={{ position: "absolute", left: 6, bottom: 7, width: 6, height: 15, backgroundColor: SHOP.apron, opacity: 0.85 }} />
        <View style={{ position: "absolute", left: 16, bottom: 7, width: 6, height: 22, backgroundColor: SHOP.gold, opacity: 0.9 }} />
        <View style={{ position: "absolute", left: 26, bottom: 7, width: 6, height: 11, backgroundColor: SHOP.apronLight, opacity: 0.9 }} />
        <View style={{ position: "absolute", left: 36, bottom: 7, width: 6, height: 18, backgroundColor: SHOP.carton, opacity: 0.9 }} />
      </View>

      {/* Pendant light and wall clock. */}
      <View style={{ position: "absolute", left: 190, top: 0, width: 1, height: 17, backgroundColor: SHOP.frameDark, opacity: 0.5 }} />
      <View style={{ position: "absolute", left: 179, top: 16, width: 23, height: 10, borderTopLeftRadius: 10, borderTopRightRadius: 10, backgroundColor: SHOP.frameDark }} />
      <View style={{ position: "absolute", left: 188, top: 26, width: 5, height: 4, borderRadius: 2, backgroundColor: SHOP.sun, opacity: 0.95 }} />
      <View style={{ position: "absolute", left: 166, top: 26, width: 17, height: 17, borderRadius: 9, borderWidth: 2, borderColor: SHOP.frame, backgroundColor: SHOP.paper }}>
        <View style={{ position: "absolute", left: 8, top: 3, width: 1.2, height: 5, backgroundColor: SHOP.ink }} />
        <View style={{ position: "absolute", left: 8, top: 7, width: 4, height: 1.2, backgroundColor: SHOP.ink }} />
      </View>

      <Shelf />

      <View style={{ position: "absolute", left: 114, bottom: 10, width: 36, height: 50 }}>
        <View style={{ position: "absolute", left: 9, bottom: 20, width: 18, height: 12, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: SHOP.pot }} />
        <View style={{ position: "absolute", left: 12, bottom: 27, width: 3, height: 17, backgroundColor: "#3F6B45", transform: [{ rotate: "-18deg" }] }} />
        <View style={{ position: "absolute", left: 19, bottom: 27, width: 3, height: 20, backgroundColor: SHOP.plant }} />
        <View style={{ position: "absolute", left: 25, bottom: 28, width: 3, height: 15, backgroundColor: "#4F8A5F", transform: [{ rotate: "18deg" }] }} />
        <View style={{ position: "absolute", left: 7, bottom: 38, width: 12, height: 7, borderRadius: 6, backgroundColor: SHOP.plant, transform: [{ rotate: "-18deg" }] }} />
        <View style={{ position: "absolute", left: 19, bottom: 42, width: 13, height: 8, borderRadius: 6, backgroundColor: "#4F8A5F", transform: [{ rotate: "9deg" }] }} />
      </View>

      <Shopkeeper />
      <Counter />

      <View style={{ position: "absolute", left: 18, bottom: 16, width: 42, height: 3, borderRadius: 2, backgroundColor: "rgba(84,53,34,0.18)" }} />
    </View>
  );
}

function DeliveryActor({ local }: { local: Animated.AnimatedInterpolation<number> }) {
  const travel = local.interpolate({
    inputRange: [0, 0.08, 0.62, 0.82, 1],
    outputRange: [-128, -128, 42, 54, 54],
    extrapolate: "clamp",
  });
  const bob = local.interpolate({
    inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
    outputRange: [0, -1.8, 0, -1.4, 0, 0],
  });
  return (
    <Animated.View style={{ position: "absolute", left: 0, top: 82, width: 148, height: 96, transform: [{ translateX: travel }, { translateY: bob }] }}>
      {/* Hand truck and the delivery goods. */}
      <View style={{ position: "absolute", left: 18, top: 12, width: 4, height: 54, borderRadius: 2, backgroundColor: SHOP.frameDark, transform: [{ rotate: "8deg" }] }} />
      <View style={{ position: "absolute", left: 14, top: 62, width: 52, height: 5, borderRadius: 2, backgroundColor: SHOP.frameDark }} />
      <View style={{ position: "absolute", left: 18, top: 66, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.ink }} />
      <View style={{ position: "absolute", left: 51, top: 66, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.ink }} />
      <View style={{ position: "absolute", left: 19, top: 36, width: 18, height: 23 }}><Product kind="rice" w={18} h={23} /></View>
      <View style={{ position: "absolute", left: 40, top: 40, width: 19, height: 19 }}><Product kind="carton" w={19} h={19} /></View>
      <View style={{ position: "absolute", left: 27, top: 25, width: 17, height: 17 }}><Product kind="carton" w={17} h={17} /></View>

      {/* Delivery person, leaning into the truck. */}
      <View style={{ position: "absolute", left: 77, top: 14, width: 40, height: 82 }}>
        <View style={{ position: "absolute", left: 13, top: 2, width: 17, height: 17, borderRadius: 9, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 12, top: 0, width: 19, height: 8, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.hair }} />
        <View style={{ position: "absolute", left: 17, top: 18, width: 9, height: 4, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 8, top: 21, width: 26, height: 38, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.customer }} />
        <View style={{ position: "absolute", left: 7, top: 29, width: 28, height: 4, backgroundColor: SHOP.cartonTape, opacity: 0.75 }} />
        <View style={{ position: "absolute", left: 3, top: 24, width: 7, height: 27, borderRadius: 3, backgroundColor: SHOP.customer }} />
        <View style={{ position: "absolute", left: 33, top: 26, width: 7, height: 25, borderRadius: 3, backgroundColor: SHOP.customer }} />
        <View style={{ position: "absolute", left: 1, top: 47, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 35, top: 47, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 11, top: 56, width: 8, height: 24, backgroundColor: SHOP.pants }} />
        <View style={{ position: "absolute", left: 24, top: 56, width: 8, height: 24, backgroundColor: SHOP.pants }} />
        <View style={{ position: "absolute", left: 8, top: 78, width: 13, height: 4, borderRadius: 2, backgroundColor: SHOP.ink }} />
        <View style={{ position: "absolute", left: 23, top: 78, width: 13, height: 4, borderRadius: 2, backgroundColor: SHOP.ink }} />
      </View>
    </Animated.View>
  );
}

const TRANSFER_TARGETS = [
  { x: 204, y: 48, w: 23, h: 25, kind: "rice" as const, crateX: 24, crateY: 146 },
  { x: 234, y: 88, w: 22, h: 24, kind: "carton" as const, crateX: 47, crateY: 149 },
  { x: 296, y: 87, w: 23, h: 25, kind: "rice" as const, crateX: 64, crateY: 147 },
];

function InventoryActor({ local }: { local: Animated.AnimatedInterpolation<number> }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Receiving crate: the same goods that arrived in scene one. */}
      <View style={{ position: "absolute", left: 22, top: 146, width: 80, height: 38, borderWidth: 2, borderColor: SHOP.frameDark, borderRadius: 2, backgroundColor: "rgba(141,91,59,0.22)" }}>
        <View style={{ position: "absolute", left: 0, right: 0, top: 11, height: 2, backgroundColor: SHOP.frameDark, opacity: 0.72 }} />
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 8, height: 2, backgroundColor: SHOP.frameDark, opacity: 0.72 }} />
        <View style={{ position: "absolute", left: 24, top: 0, width: 2, height: 36, backgroundColor: SHOP.frameDark, opacity: 0.6 }} />
        <View style={{ position: "absolute", left: 54, top: 0, width: 2, height: 36, backgroundColor: SHOP.frameDark, opacity: 0.6 }} />
      </View>

      {TRANSFER_TARGETS.map((target, i) => {
        const start = 0.08 + i * 0.11;
        const end = start + 0.33;
        const move = local.interpolate({
          inputRange: [0, start, end, 1],
          outputRange: [0, 0, 1, 1],
          extrapolate: "clamp",
        });
        const x = move.interpolate({ inputRange: [0, 1], outputRange: [target.crateX - target.x, 0] });
        const y = move.interpolate({ inputRange: [0, 1], outputRange: [target.crateY - target.y, 0] });
        const landed = local.interpolate({
          inputRange: [end, end + 0.06, end + 0.25, 1],
          outputRange: [0, 1, 1, 0.55],
          extrapolate: "clamp",
        });
        return (
          <View key={target.kind + i} style={{ position: "absolute", left: target.x, top: target.y, width: target.w, height: target.h }}>
            <Animated.View style={{ position: "absolute", left: -3, top: -3, width: target.w + 6, height: target.h + 6, borderRadius: 3, borderWidth: 1.4, borderColor: SHOP.apronLight, opacity: landed }} />
            <Animated.View style={{ position: "absolute", left: 0, top: 0, opacity: 1, transform: [{ translateX: x }, { translateY: y }] }}>
              <Product kind={target.kind} w={target.w} h={target.h} />
            </Animated.View>
            <Animated.View style={{
              position: "absolute", right: -8, top: -8, width: 14, height: 14, borderRadius: 7,
              backgroundColor: SHOP.apron, alignItems: "center", justifyContent: "center", opacity: landed,
              transform: [{ scale: landed }],
            }}>
              <Icon name="check" size={8} color={SHOP.paper} strokeWidth={2.4} />
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}

function SaleActor({ local }: { local: Animated.AnimatedInterpolation<number> }) {
  const walk = local.interpolate({
    inputRange: [0, 0.06, 0.3, 0.58, 0.8, 1],
    outputRange: [-200, -200, 0, 0, -215, -215],
    extrapolate: "clamp",
  });
  const step = local.interpolate({
    inputRange: [0, 0.12, 0.24, 0.36, 0.5, 0.7, 0.82, 1],
    outputRange: [0, -1.5, 0, -1.2, 0, -1.5, 0, 0],
  });
  const paid = local.interpolate({
    inputRange: [0.38, 0.47, 0.95, 1],
    outputRange: [0, 1, 1, 1],
    extrapolate: "clamp",
  });
  const productMove = local.interpolate({
    inputRange: [0.06, 0.34, 1],
    outputRange: [0, 1, 1],
    extrapolate: "clamp",
  });
  const productX = productMove.interpolate({ inputRange: [0, 1], outputRange: [89, 0] });
  const productY = productMove.interpolate({ inputRange: [0, 1], outputRange: [-32, 0] });
  // The bottle leaves the counter as the paper bag appears in the customer's hand.
  const productOpacity = local.interpolate({
    inputRange: [0, 0.32, 0.37, 0.44, 1],
    outputRange: [1, 1, 1, 0, 0],
    extrapolate: "clamp",
  });
  const receipt = local.interpolate({
    inputRange: [0.39, 0.47, 0.86, 0.94],
    outputRange: [0, 1, 1, 0],
    extrapolate: "clamp",
  });
  const receiptDrop = local.interpolate({
    inputRange: [0.39, 0.47],
    outputRange: [-8, 0],
    extrapolate: "clamp",
  });
  return (
    <View style={StyleSheet.absoluteFill}>
      {/* One bottle travels from the shelf to the counter. */}
      <View style={{ position: "absolute", left: 239, top: 119, width: 13, height: 23 }}>
        <Animated.View style={{ position: "absolute", left: 0, top: 0, opacity: productOpacity, transform: [{ translateX: productX }, { translateY: productY }] }}>
          <Product kind="bottle" w={13} h={23} />
        </Animated.View>
      </View>

      {/* Receipt printing at the till. */}
      <Animated.View style={{
        position: "absolute", left: 319, top: 116, width: 15, height: 23, backgroundColor: SHOP.paper,
        borderRadius: 1, borderWidth: 0.8, borderColor: SHOP.riceEdge, opacity: receipt,
        transform: [{ translateY: receiptDrop }], padding: 2.4, gap: 2,
      }}>
        <View style={{ width: "100%", height: 1, backgroundColor: SHOP.ink, opacity: 0.45 }} />
        <View style={{ width: "70%", height: 1, backgroundColor: SHOP.ink, opacity: 0.35 }} />
        <View style={{ width: "100%", height: 1, backgroundColor: SHOP.ink, opacity: 0.45 }} />
        <View style={{ width: "55%", height: 1, backgroundColor: SHOP.ink, opacity: 0.35 }} />
      </Animated.View>

      {/* Customer: walks in, receives the bag, then leaves through the same door. */}
      <Animated.View style={{ position: "absolute", left: 183, top: 94, width: 48, height: 92, transform: [{ translateX: walk }, { translateY: step }] }}>
        <View style={{ position: "absolute", left: 14, top: 2, width: 18, height: 18, borderRadius: 9, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 13, top: 0, width: 20, height: 8, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.hair }} />
        <View style={{ position: "absolute", left: 19, top: 19, width: 9, height: 4, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 10, top: 23, width: 27, height: 37, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.shirt }} />
        <View style={{ position: "absolute", left: 15, top: 30, width: 17, height: 25, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: SHOP.customer, opacity: 0.92 }} />
        <View style={{ position: "absolute", left: 5, top: 27, width: 7, height: 27, borderRadius: 3, backgroundColor: SHOP.shirt }} />
        <View style={{ position: "absolute", left: 35, top: 27, width: 7, height: 27, borderRadius: 3, backgroundColor: SHOP.shirt }} />
        <View style={{ position: "absolute", left: 2, top: 49, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 36, top: 49, width: 9, height: 9, borderRadius: 5, backgroundColor: SHOP.skin }} />
        <View style={{ position: "absolute", left: 13, top: 58, width: 8, height: 27, backgroundColor: SHOP.pants }} />
        <View style={{ position: "absolute", left: 27, top: 58, width: 8, height: 27, backgroundColor: SHOP.pants }} />
        <View style={{ position: "absolute", left: 10, top: 84, width: 13, height: 4, borderRadius: 2, backgroundColor: SHOP.ink }} />
        <View style={{ position: "absolute", left: 26, top: 84, width: 13, height: 4, borderRadius: 2, backgroundColor: SHOP.ink }} />
        <Animated.View style={{ position: "absolute", left: 35, top: 49, width: 17, height: 23, opacity: paid }}>
          <View style={{ position: "absolute", left: 2, top: 0, width: 13, height: 9, borderTopLeftRadius: 7, borderTopRightRadius: 7, borderWidth: 1.6, borderBottomWidth: 0, borderColor: SHOP.frame }} />
          <View style={{ position: "absolute", left: 0, top: 5, width: 17, height: 18, borderRadius: 1, backgroundColor: SHOP.paper, borderWidth: 0.8, borderColor: SHOP.riceEdge }} />
          <View style={{ position: "absolute", left: 4, top: 2, width: 9, height: 6, borderRadius: 1, backgroundColor: SHOP.carton }} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------------------------------------------ */

function ProgressRail({ master, reduced }: { master: Animated.Value; reduced: boolean }) {
  const c = useTheme();
  const widths = reduced ? [1, 1, 1] : [
    grow(master, at(20), at(INTRO_STAGE_MS[1])),
    grow(master, at(INTRO_STAGE_MS[1]), at(INTRO_STAGE_MS[2])),
    grow(master, at(INTRO_STAGE_MS[2]), at(INTRO_STAGE_MS[3])),
  ];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 6, width: "100%" }}>
      {widths.map((scaleX, i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: TRACK, overflow: "hidden" }}>
          <Animated.View style={{
            width: "100%", height: 4, borderRadius: 2, backgroundColor: c.sidebarIndicator,
            transformOrigin: "left", transform: [{ scaleX }],
          }} />
        </View>
      ))}
    </View>
  );
}

function StaticShop({ width }: { width: number }) {
  const scale = width / SCENE_W;
  return (
    <View style={{ width, height: SCENE_H * scale, borderRadius: 16, overflow: "hidden", backgroundColor: SHOP.wall }}>
      <View style={{ position: "absolute", width: SCENE_W, height: SCENE_H, left: (width - SCENE_W) / 2, top: (SCENE_H * scale - SCENE_H) / 2, transform: [{ scale }] }}>
        <ShopBackdrop />
        <View style={{ position: "absolute", left: 22, top: 146, width: 80, height: 38, borderWidth: 2, borderColor: SHOP.frameDark, borderRadius: 2, backgroundColor: "rgba(141,91,59,0.22)" }}>
          <View style={{ position: "absolute", left: 0, right: 0, top: 11, height: 2, backgroundColor: SHOP.frameDark, opacity: 0.72 }} />
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 8, height: 2, backgroundColor: SHOP.frameDark, opacity: 0.72 }} />
        </View>
        <View style={{ position: "absolute", left: 31, top: 145, width: 18, height: 23 }}><Product kind="rice" w={18} h={23} /></View>
        <View style={{ position: "absolute", left: 54, top: 148, width: 19, height: 19 }}><Product kind="carton" w={19} h={19} /></View>
        <View style={{ position: "absolute", left: 76, top: 146, width: 16, height: 21 }}><Product kind="bottle" w={11} h={21} /></View>
        <View style={{ position: "absolute", left: 184, top: 101, width: 48, height: 88 }}>
          <View style={{ position: "absolute", left: 14, top: 2, width: 18, height: 18, borderRadius: 9, backgroundColor: SHOP.skin }} />
          <View style={{ position: "absolute", left: 13, top: 0, width: 20, height: 8, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.hair }} />
          <View style={{ position: "absolute", left: 10, top: 23, width: 27, height: 35, borderTopLeftRadius: 9, borderTopRightRadius: 9, backgroundColor: SHOP.shirt }} />
          <View style={{ position: "absolute", left: 15, top: 30, width: 17, height: 24, backgroundColor: SHOP.customer, opacity: 0.92 }} />
          <View style={{ position: "absolute", left: 12, top: 58, width: 8, height: 26, backgroundColor: SHOP.pants }} />
          <View style={{ position: "absolute", left: 26, top: 58, width: 8, height: 26, backgroundColor: SHOP.pants }} />
          <View style={{ position: "absolute", left: 35, top: 49, width: 17, height: 23, borderRadius: 1, backgroundColor: SHOP.paper, borderWidth: 0.8, borderColor: SHOP.riceEdge }} />
        </View>
      </View>
    </View>
  );
}

/** Static, readable version of the same three steps for people who ask for reduced motion. */
function ReducedIntro({ returning, width }: { returning: boolean; width: number }) {
  const c = useTheme();
  const t = useT();
  const rows = [
    { icon: "box" as const, title: "intro.step1Title" as const, text: "intro.step1Text" as const },
    { icon: "layers" as const, title: "intro.step2Title" as const, text: "intro.step2Text" as const },
    { icon: "cart" as const, title: "intro.step3Title" as const, text: "intro.step3Text" as const },
  ];
  if (returning) {
    return (
      <View style={{ width: "100%", maxWidth: 430, alignItems: "center", gap: space.md }}>
        <BrandMark size={56} accent={c.sidebarIndicator} ink={c.sidebar} />
        <Text style={{ color: c.sidebarInk, ...type.display }}>{t("intro.welcome")}</Text>
        <Text style={{ color: c.sidebarMuted, textAlign: "center", ...type.body }}>{t("brand.tagline")}</Text>
      </View>
    );
  }
  return (
    <ScrollView
      style={{ width: "100%", maxHeight: "100%" }}
      contentContainerStyle={{ alignItems: "center", gap: space.sm, paddingVertical: space.xs }}
      showsVerticalScrollIndicator={false}
    >
      <StaticShop width={Math.min(width, 330)} />
      <View style={{ width: "100%", maxWidth: 430, borderRadius: radius.lg, borderWidth: 1, borderColor: HAIRLINE, backgroundColor: CARD, padding: space.md, gap: 10 }}>
        {rows.map((row) => (
          <View key={row.title} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: "rgba(45,212,191,0.16)", alignItems: "center", justifyContent: "center" }}>
              <Icon name={row.icon} size={16} color={c.sidebarIndicator} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={{ color: c.sidebarInk, fontSize: 15, lineHeight: 20, fontWeight: "800", letterSpacing: 0.3 }}>{t(row.title)}</Text>
              <Text style={{ color: CAPTION, fontSize: 14, lineHeight: 19, fontWeight: "500" }}>{t(row.text)}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text style={{ color: c.sidebarMuted, textAlign: "center", ...type.small }}>{t("intro.tagline")}</Text>
    </ScrollView>
  );
}

/**
 * The branded introduction, mounted once by the root layout and never by a screen. It covers the
 * app while startup continues underneath, so database, session, language and sync work are not
 * delayed. `mode` resolves once the device preference has been read; only a first installation
 * gets the full stock-in → inventory → sale story.
 */
export function BrandIntro({ mode, onDone }: { mode: IntroMode; onDone: () => void }) {
  const c = useTheme();
  const t = useT();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const master = useRef(new Animated.Value(0)).current;
  const [sceneIndex, setSceneIndex] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  const short = height < 700;

  const maxContentWidth = width >= 1000 ? 560 : width >= 720 ? 500 : 460;
  const cardWidth = Math.max(264, Math.min(width - space.lg * 2, maxContentWidth));
  const maxSceneHeight = height < 700 ? 240 : height < 820 ? 290 : 350;
  const sceneWidth = Math.min(cardWidth - 24, maxSceneHeight * SCENE_RATIO);
  const sceneHeight = sceneWidth / SCENE_RATIO;
  const sceneScale = sceneWidth / SCENE_W;
  const titleSize = cardWidth >= 500 ? 25 : cardWidth >= 420 ? 23 : 21;
  const captionSize = cardWidth >= 500 ? 17 : 16;

  // Keep the accessibility tree on the scene that is actually visible. The animation itself stays
  // on the native driver; these timers only decide which text a screen reader may announce.
  useEffect(() => {
    setSceneIndex(0);
    if (mode !== "first" || reduced) return;
    const timers = [
      setTimeout(() => setSceneIndex(1), INTRO_STAGE_MS[1]),
      setTimeout(() => setSceneIndex(2), INTRO_STAGE_MS[2]),
      setTimeout(() => setSceneIndex(3), INTRO_STAGE_MS[3]),
    ];
    return () => timers.forEach(clearTimeout);
  }, [mode, reduced]);

  useEffect(() => {
    if (mode === "loading" || mode === "done") return;
    if (reduced) {
      master.setValue(1);
      const timer = setTimeout(() => done.current(), introDurationFor(mode, true));
      return () => clearTimeout(timer);
    }
    master.setValue(0);
    const animation = Animated.timing(master, {
      toValue: 1,
      duration: introDurationFor(mode, false),
      easing: Easing.linear,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start(({ finished }) => { if (finished) done.current(); });
    return () => animation.stop();
  }, [mode, reduced, master]);

  const overlayOpacity = mode === "returning" && !reduced
    ? master.interpolate({ inputRange: [0, 0.12, 0.82, 1], outputRange: [0, 1, 1, 0], extrapolate: "clamp" })
    : mode === "first" && !reduced
      ? master.interpolate({ inputRange: [0, 0.01, at(7970), 1], outputRange: [0.98, 1, 1, 0], extrapolate: "clamp" })
      : 1;

  // The final hand-off begins at 7.34s and is fully visible by 7.58s. No caption is still being
  // read underneath it: scene three has faded out by then.
  const doneOpacity = mode === "first" && !reduced
    ? master.interpolate({ inputRange: [at(7150), at(7420), 1], outputRange: [0, 1, 1], extrapolate: "clamp" })
    : mode === "first" ? 1 : 0;

  const sceneOpacity = {
    a: mode === "first" && !reduced ? fade(master, at(0), at(160), at(2320), at(2520)) : mode === "first" ? 1 : 0,
    b: mode === "first" && !reduced ? fade(master, at(2500), at(2700), at(4820), at(5020)) : 0,
    c: mode === "first" && !reduced ? fade(master, at(5000), at(5200), at(6950), at(7150)) : 0,
  };
  const local = {
    a: master.interpolate({ inputRange: [at(0), at(INTRO_STAGE_MS[1])], outputRange: [0, 1], extrapolate: "clamp" }),
    b: master.interpolate({ inputRange: [at(INTRO_STAGE_MS[1]), at(INTRO_STAGE_MS[2])], outputRange: [0, 1], extrapolate: "clamp" }),
    c: master.interpolate({ inputRange: [at(INTRO_STAGE_MS[2]), at(INTRO_STAGE_MS[3])], outputRange: [0, 1], extrapolate: "clamp" }),
  };
  const returningScale = master.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.94, 1, 1.02], extrapolate: "clamp" });
  const hiddenScene = (index: number) => mode === "first" && !reduced && sceneIndex !== index;

  const scenes = [
    {
      key: "a",
      title: t("intro.step1Title"),
      text: t("intro.step1Text"),
      opacity: sceneOpacity.a,
    },
    {
      key: "b",
      title: t("intro.step2Title"),
      text: t("intro.step2Text"),
      opacity: sceneOpacity.b,
    },
    {
      key: "c",
      title: t("intro.step3Title"),
      text: t("intro.step3Text"),
      opacity: sceneOpacity.c,
    },
  ];

  return (
    <Animated.View
      testID="brand-intro"
      accessibilityViewIsModal
      aria-modal
      accessibilityLabel={t("intro.a11y")}
      style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 40, backgroundColor: c.sidebar, opacity: overlayOpacity }]}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={{ position: "absolute", width: 520, height: 520, borderRadius: 260, backgroundColor: GLOW, top: -250, right: -230 }} />
        <View style={{ position: "absolute", width: 420, height: 420, borderRadius: 210, backgroundColor: GLOW_SOFT, bottom: -230, left: -200 }} />
        <View style={{ position: "absolute", width: 1, height: "100%", backgroundColor: "rgba(255,255,255,0.035)", left: "26%" }} />
        <View style={{ position: "absolute", width: 1, height: "100%", backgroundColor: "rgba(255,255,255,0.035)", right: "26%" }} />
      </View>

      <View style={{
        flex: 1, paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md,
        paddingHorizontal: space.lg, alignItems: "center", justifyContent: "space-between", gap: space.md,
      }}>
        <View style={{ width: "100%", maxWidth: maxContentWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
          <BrandLockup compact={short} />
          {mode === "first" || mode === "returning" ? (
            <Pressable
              testID="intro-skip"
              accessibilityRole="button"
              accessibilityLabel={t("intro.skip")}
              onPress={() => done.current()}
              style={({ hovered, pressed, focused }: any) => ({
                minHeight: 44, minWidth: 74, paddingHorizontal: space.md, borderRadius: radius.pill,
                flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                borderWidth: 1.2, borderColor: focused ? c.sidebarIndicator : "rgba(255,255,255,0.3)",
                backgroundColor: hovered || pressed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)",
              })}
            >
              <Text style={{ color: c.sidebarInk, fontSize: 14, lineHeight: 19, fontWeight: "800" }}>{t("intro.skip")}</Text>
              <Icon name="arrowRight" size={14} color={c.sidebarInk} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ width: "100%", flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: space.sm }}>
          {mode === "loading" ? (
            <View style={{ alignItems: "center", gap: space.lg }}>
              <BrandMark size={58} accent={c.sidebarIndicator} ink={c.sidebar} />
              <Text style={{ color: c.sidebarMuted, ...type.small }}>{t("intro.loading")}</Text>
            </View>
          ) : reduced ? (
            <ReducedIntro returning={mode === "returning"} width={Math.min(width - space.lg * 4, 350)} />
          ) : mode === "returning" ? (
            <Animated.View style={{ alignItems: "center", gap: space.md, transform: [{ scale: returningScale }] }}>
              <BrandMark size={70} accent={c.sidebarIndicator} ink={c.sidebar} />
              <Text style={{ color: c.sidebarInk, ...type.display }}>{t("intro.welcome")}</Text>
              <Text style={{ color: c.sidebarMuted, ...type.body }}>{t("brand.tagline")}</Text>
            </Animated.View>
          ) : (
            <View style={{
              width: "100%", maxWidth: maxContentWidth, borderRadius: 24, borderWidth: 1, borderColor: HAIRLINE,
              backgroundColor: CARD, padding: 12, gap: space.md, overflow: "hidden",
              shadowColor: "#041413", shadowOpacity: 0.3, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 10,
            }}>
              <View style={{ width: sceneWidth, height: sceneHeight, borderRadius: 16, overflow: "hidden", alignSelf: "center", backgroundColor: SHOP.wall }}>
                <View style={{
                  position: "absolute", width: SCENE_W, height: SCENE_H,
                  left: (sceneWidth - SCENE_W) / 2, top: (sceneHeight - SCENE_H) / 2,
                  transform: [{ scale: sceneScale }],
                }}>
                  <ShopBackdrop />
                  <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: sceneOpacity.a }]}>
                    <DeliveryActor local={local.a} />
                  </Animated.View>
                  <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: sceneOpacity.b }]}>
                    <InventoryActor local={local.b} />
                  </Animated.View>
                  <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: sceneOpacity.c }]}>
                    <SaleActor local={local.c} />
                  </Animated.View>
                </View>
                <Animated.View
                  accessibilityElementsHidden={!(mode === "first" && !reduced && sceneIndex === 3)}
                  importantForAccessibility={mode === "first" && !reduced && sceneIndex === 3 ? "auto" : "no-hide-descendants"}
                  style={[StyleSheet.absoluteFill, {
                    backgroundColor: "rgba(8,30,28,0.95)",
                    alignItems: "center", justifyContent: "center", gap: 12, opacity: doneOpacity,
                  }]}
                >
                  <BrandMark size={58} accent={c.sidebarIndicator} ink={c.sidebar} />
                  <Text style={{ color: SHOP.white, fontSize: 27, lineHeight: 32, fontWeight: "800", letterSpacing: -0.4 }}>{t("app.name")}</Text>
                </Animated.View>
              </View>

              <View style={{ minHeight: 112, justifyContent: "center", paddingHorizontal: space.xs }}>
                {scenes.map((scene) => (
                  <Animated.View
                    key={scene.key}
                    accessibilityElementsHidden={hiddenScene(scenes.indexOf(scene))}
                    importantForAccessibility={hiddenScene(scenes.indexOf(scene)) ? "no-hide-descendants" : "auto"}
                    style={{ position: "absolute", left: space.xs, right: space.xs, top: 0, bottom: 0, justifyContent: "center", gap: 6, opacity: scene.opacity }}
                  >
                    <Text
                      numberOfLines={2}
                      style={{
                        color: c.sidebarInk, textAlign: "center", fontSize: titleSize, lineHeight: titleSize * 1.24,
                        fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase",
                      }}
                    >
                      {scene.title}
                    </Text>
                    <Text numberOfLines={3} style={{ color: CAPTION, textAlign: "center", fontSize: captionSize, lineHeight: captionSize + 7, fontWeight: "500" }}>
                      {scene.text}
                    </Text>
                  </Animated.View>
                ))}
                <Animated.View
                  accessibilityElementsHidden={!(mode === "first" && !reduced && sceneIndex === 3)}
                  importantForAccessibility={mode === "first" && !reduced && sceneIndex === 3 ? "auto" : "no-hide-descendants"}
                  style={{ position: "absolute", left: space.xs, right: space.xs, top: 0, bottom: 0, justifyContent: "center", gap: 5, opacity: doneOpacity }}
                >
                  <Text style={{ color: c.sidebarInk, textAlign: "center", fontSize: 17, lineHeight: 24, fontWeight: "700" }}>
                    {t("intro.tagline")}
                  </Text>
                </Animated.View>
              </View>

              <View style={{ paddingHorizontal: space.xs, paddingBottom: 2 }}>
                <ProgressRail master={master} reduced={reduced} />
              </View>
            </View>
          )}
        </View>

        <View style={{ width: "100%", maxWidth: maxContentWidth, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 20 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.sidebarIndicator }} />
          <Text style={{ color: c.sidebarMuted, ...type.small }}>{t("shell.offlineNote")}</Text>
        </View>
      </View>
    </Animated.View>
  );
}
