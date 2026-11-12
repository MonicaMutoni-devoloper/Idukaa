import { View, type ViewStyle } from "react-native";

/**
 * A tiny geometric icon set drawn with plain Views: no icon font, no SVG dependency, identical on
 * web and Android. Every glyph sits on an 18px grid and scales with `size`.
 */
export type IconName =
  | "home" | "cart" | "box" | "layers" | "receipt" | "sync" | "settings" | "checkSquare"
  | "chart" | "shield" | "more" | "sun" | "moon" | "monitor" | "panel" | "close" | "check"
  | "alert" | "search" | "plus" | "minus" | "arrowRight" | "chevronDown" | "chevronLeft" | "chevronRight"
  | "eye" | "eyeOff" | "users" | "calendar";

export function Icon({ name, size = 18, color, bg = "transparent", strokeWidth = 1.6 }: {
  name: IconName; size?: number; color: string; bg?: string; strokeWidth?: number;
}) {
  const s = size;
  const u = (n: number) => (n * s) / 18;
  const line = (style: ViewStyle): ViewStyle => ({ position: "absolute", backgroundColor: color, ...style });
  const frame = (style: ViewStyle): ViewStyle => ({ position: "absolute", borderColor: color, borderWidth: u(strokeWidth), ...style });
  const dot = (x: number, y: number, w: number, h = w): ViewStyle => line({ left: u(x), top: u(y), width: u(w), height: u(h), borderRadius: u(w / 2) });

  const glyph = () => {
    switch (name) {
      case "home":
        return (
          <>
            <View style={{ position: "absolute", left: u(3.6), top: u(1.4), width: u(10.8), height: u(10.8), borderColor: color, borderWidth: u(strokeWidth), transform: [{ rotate: "45deg" }], borderTopLeftRadius: u(2), borderTopRightRadius: u(2) }} />
            <View style={frame({ left: u(5), top: u(8), width: u(8), height: u(7), borderBottomLeftRadius: u(1.5), borderBottomRightRadius: u(1.5), borderTopWidth: 0, backgroundColor: bg })} />
            <View style={line({ left: u(8), top: u(11.5), width: u(2), height: u(3.5) })} />
          </>
        );
      case "cart":
        return (
          <>
            <View style={frame({ left: u(1.4), top: u(4), width: u(12), height: u(8), borderRadius: u(1.5) })} />
            <View style={line({ left: u(1.4), top: u(7), width: u(12), height: u(strokeWidth) })} />
            <View style={line({ left: u(1), top: u(2), width: u(2.4), height: u(strokeWidth), transform: [{ rotate: "18deg" }] })} />
            {[u(5), u(10)].map((x) => <View key={x} style={{ position: "absolute", left: x, top: u(14.2), width: u(2.2), height: u(2.2), borderRadius: u(1.1), borderWidth: u(strokeWidth), borderColor: color }} />)}
          </>
        );
      case "box":
        return (
          <>
            <View style={frame({ left: u(2.2), top: u(3), width: u(13.6), height: u(11.5), borderRadius: u(1.5) })} />
            <View style={line({ left: u(2.2), top: u(6.6), width: u(13.6), height: u(strokeWidth) })} />
            <View style={line({ left: u(7.4), top: u(3), width: u(3.2), height: u(3.6), backgroundColor: color })} />
          </>
        );
      case "layers":
        return (
          <>
            <View style={line({ left: u(2.4), top: u(4), width: u(13.2), height: u(2.4), borderRadius: u(1) })} />
            <View style={line({ left: u(2.4), top: u(8.2), width: u(13.2), height: u(2.4), borderRadius: u(1) })} />
            <View style={line({ left: u(2.4), top: u(12.4), width: u(13.2), height: u(2.4), borderRadius: u(1) })} />
          </>
        );
      case "receipt":
        return (
          <>
            <View style={frame({ left: u(3.4), top: u(1.4), width: u(11.2), height: u(15.2), borderRadius: u(1.5) })} />
            {[u(6), u(8.6), u(11.2)].map((y) => <View key={y} style={line({ left: u(5.6), top: y, width: u(6.8), height: u(1) })} />)}
          </>
        );
      case "sync":
        return (
          <>
            <View style={line({ left: u(3), top: u(4.2), width: u(11), height: u(strokeWidth), borderRadius: u(1) })} />
            <View style={line({ left: u(4), top: u(13.6), width: u(11), height: u(strokeWidth), borderRadius: u(1) })} />
            <View style={{ position: "absolute", left: u(10.6), top: u(1.8), width: u(3.6), height: u(3.6), borderTopWidth: u(strokeWidth), borderRightWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "45deg" }] }} />
            <View style={{ position: "absolute", left: u(3.6), top: u(12.4), width: u(3.6), height: u(3.6), borderTopWidth: u(strokeWidth), borderRightWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "225deg" }] }} />
          </>
        );
      case "settings":
        return (
          <>
            <View style={{ position: "absolute", left: u(6.4), top: u(6.4), width: u(5.2), height: u(5.2), borderRadius: u(2.6), borderWidth: u(strokeWidth * 1.2), borderColor: color }} />
            {[0, 45, 90, 135].map((deg) => (
              <View key={deg} style={{ position: "absolute", left: u(8.2), top: u(1.4), width: u(strokeWidth * 1.3), height: u(15.2), backgroundColor: color, transform: [{ rotate: `${deg}deg` }] }} />
            ))}
            <View style={{ position: "absolute", left: u(7.2), top: u(7.2), width: u(3.6), height: u(3.6), borderRadius: u(1.8), backgroundColor: bg }} />
          </>
        );
      case "checkSquare":
        return (
          <>
            <View style={frame({ left: u(2.4), top: u(2.4), width: u(13.2), height: u(13.2), borderRadius: u(2.4) })} />
            <View style={{ position: "absolute", left: u(5.6), top: u(7.1), width: u(4.2), height: u(4.2), borderLeftWidth: u(strokeWidth * 1.2), borderBottomWidth: u(strokeWidth * 1.2), borderColor: color, transform: [{ rotate: "-45deg" }] }} />
          </>
        );
      case "chart":
        return (
          <>
            <View style={line({ left: u(1.6), top: u(15), width: u(14.8), height: u(strokeWidth) })} />
            <View style={line({ left: u(3.4), top: u(8.4), width: u(3), height: u(6.6), borderRadius: u(1) })} />
            <View style={line({ left: u(7.6), top: u(4.8), width: u(3), height: u(10.2), borderRadius: u(1) })} />
            <View style={line({ left: u(11.8), top: u(9.8), width: u(3), height: u(5.2), borderRadius: u(1) })} />
          </>
        );
      case "shield":
        return (
          <>
            <View style={{ position: "absolute", left: u(3.4), top: u(2.6), width: u(11.2), height: u(11.2), borderColor: color, borderWidth: u(strokeWidth), borderRadius: u(2), transform: [{ rotate: "45deg" }] }} />
            <View style={{ position: "absolute", left: u(7.6), top: u(6.3), width: u(3.4), height: u(3.4), borderLeftWidth: u(strokeWidth * 1.2), borderBottomWidth: u(strokeWidth * 1.2), borderColor: color, transform: [{ rotate: "-45deg" }] }} />
          </>
        );
      case "more":
        return <>{[u(3.4), u(8.2), u(13)].map((y) => <View key={y} style={dot(7.6, y, 2.4)} />)}</>;
      case "sun":
        return (
          <>
            <View style={{ position: "absolute", left: u(5.4), top: u(5.4), width: u(7.2), height: u(7.2), borderRadius: u(3.6), borderWidth: u(strokeWidth + 0.2), borderColor: color }} />
            {[0, 45, 90, 135].map((deg) => (
              <View key={deg} style={{ position: "absolute", left: u(8.2), top: u(0.8), width: u(strokeWidth * 1.2), height: u(16.4), backgroundColor: color, transform: [{ rotate: `${deg}deg` }] }} />
            ))}
            <View style={{ position: "absolute", left: u(6.3), top: u(6.3), width: u(5.4), height: u(5.4), borderRadius: u(2.7), backgroundColor: bg }} />
          </>
        );
      case "moon":
        return (
          <>
            <View style={{ position: "absolute", left: u(2.4), top: u(2.4), width: u(13.2), height: u(13.2), borderRadius: u(6.6), backgroundColor: color }} />
            <View style={{ position: "absolute", left: u(6.4), top: u(0.8), width: u(11.4), height: u(11.4), borderRadius: u(5.7), backgroundColor: bg }} />
          </>
        );
      case "monitor":
        return (
          <>
            <View style={frame({ left: u(1.4), top: u(2.8), width: u(15.2), height: u(10.4), borderRadius: u(1.8) })} />
            <View style={line({ left: u(7.4), top: u(13.2), width: u(3.2), height: u(1.6) })} />
            <View style={line({ left: u(5), top: u(14.8), width: u(8), height: u(1.4), borderRadius: u(1) })} />
          </>
        );
      case "panel":
        return (
          <>
            <View style={frame({ left: u(1.8), top: u(3), width: u(14.4), height: u(12), borderRadius: u(2) })} />
            <View style={line({ left: u(6.6), top: u(3), width: u(strokeWidth), height: u(12) })} />
          </>
        );
      case "close":
        return (
          <>
            <View style={line({ left: u(3), top: u(8.2), width: u(12), height: u(strokeWidth + 0.2), borderRadius: u(1), transform: [{ rotate: "45deg" }] })} />
            <View style={line({ left: u(3), top: u(8.2), width: u(12), height: u(strokeWidth + 0.2), borderRadius: u(1), transform: [{ rotate: "-45deg" }] })} />
          </>
        );
      case "check":
        return <View style={{ position: "absolute", left: u(4), top: u(6.4), width: u(6.6), height: u(6.6), borderLeftWidth: u(strokeWidth * 1.3), borderBottomWidth: u(strokeWidth * 1.3), borderColor: color, transform: [{ rotate: "-45deg" }] }} />;
      case "alert":
        return (
          <>
            <View style={{ position: "absolute", left: u(7.6), top: u(2), width: u(1.4), height: u(8.4), backgroundColor: color, borderRadius: u(1) }} />
            <View style={dot(7.9, u(13), 1.9)} />
          </>
        );
      case "search":
        return (
          <>
            <View style={{ position: "absolute", left: u(2.4), top: u(2.4), width: u(9.2), height: u(9.2), borderRadius: u(4.6), borderWidth: u(strokeWidth), borderColor: color }} />
            <View style={line({ left: u(10.6), top: u(11.6), width: u(5), height: u(strokeWidth + 0.2), borderRadius: u(1), transform: [{ rotate: "45deg" }] })} />
          </>
        );
      case "plus":
        return (
          <>
            <View style={line({ left: u(3), top: u(8.2), width: u(12), height: u(strokeWidth), borderRadius: u(1) })} />
            <View style={line({ left: u(8.2), top: u(3), width: u(strokeWidth), height: u(12), borderRadius: u(1) })} />
          </>
        );
      case "minus":
        return <View style={line({ left: u(3), top: u(8.2), width: u(12), height: u(strokeWidth), borderRadius: u(1) })} />;
      case "arrowRight":
        return (
          <>
            <View style={line({ left: u(3), top: u(8.2), width: u(12), height: u(strokeWidth), borderRadius: u(1) })} />
            <View style={{ position: "absolute", left: u(9.6), top: u(4.8), width: u(4.6), height: u(4.6), borderTopWidth: u(strokeWidth), borderRightWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "45deg" }] }} />
          </>
        );
      case "chevronDown":
        return <View style={{ position: "absolute", left: u(5.4), top: u(6.6), width: u(7.4), height: u(7.4), borderRightWidth: u(strokeWidth), borderBottomWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "45deg" }] }} />;
      case "chevronLeft":
        return <View style={{ position: "absolute", left: u(6.8), top: u(5.4), width: u(7.4), height: u(7.4), borderLeftWidth: u(strokeWidth), borderBottomWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "45deg" }] }} />;
      case "chevronRight":
        return <View style={{ position: "absolute", left: u(5.4), top: u(5.4), width: u(7.4), height: u(7.4), borderTopWidth: u(strokeWidth), borderRightWidth: u(strokeWidth), borderColor: color, transform: [{ rotate: "45deg" }] }} />;
      case "eye":
        return (
          <>
            <View style={frame({ left: u(1.6), top: u(5), width: u(14.8), height: u(8), borderRadius: u(4), backgroundColor: bg })} />
            <View style={{ position: "absolute", left: u(7.1), top: u(6.9), width: u(3.8), height: u(3.8), borderRadius: u(1.9), backgroundColor: color }} />
          </>
        );
      case "eyeOff":
        return (
          <>
            <View style={frame({ left: u(1.6), top: u(5), width: u(14.8), height: u(8), borderRadius: u(4), backgroundColor: bg })} />
            <View style={{ position: "absolute", left: u(7.1), top: u(6.9), width: u(3.8), height: u(3.8), borderRadius: u(1.9), backgroundColor: color }} />
            <View style={line({ left: u(2.2), top: u(8.1), width: u(14), height: u(strokeWidth + 0.4), borderRadius: u(1), transform: [{ rotate: "34deg" }] })} />
          </>
        );
      case "calendar":
        return (
          <>
            <View style={frame({ left: u(2), top: u(3.4), width: u(14), height: u(12), borderRadius: u(2) })} />
            <View style={line({ left: u(2), top: u(6.8), width: u(14), height: u(strokeWidth) })} />
            <View style={line({ left: u(5.2), top: u(1.4), width: u(1.6), height: u(3), borderRadius: u(0.8) })} />
            <View style={line({ left: u(11.2), top: u(1.4), width: u(1.6), height: u(3), borderRadius: u(0.8) })} />
            <View style={dot(5.4, u(9.2), 1.5)} />
            <View style={dot(8.4, u(9.2), 1.5)} />
            <View style={dot(11.4, u(9.2), 1.5)} />
          </>
        );
      case "users":
        return (
          <>
            <View style={frame({ left: u(1.8), top: u(1.6), width: u(6.4), height: u(6.4), borderRadius: u(3.2), backgroundColor: bg })} />
            <View style={frame({ left: u(1.2), top: u(10), width: u(7.6), height: u(6.4), borderRadius: u(3.2), backgroundColor: bg })} />
            <View style={{ position: "absolute", left: u(11.4), top: u(3), width: u(4.8), height: u(4.8), borderRadius: u(2.4), backgroundColor: color, opacity: 0.55 }} />
            <View style={{ position: "absolute", left: u(10.6), top: u(10.4), width: u(6), height: u(5.6), borderRadius: u(2.8), backgroundColor: color, opacity: 0.55 }} />
          </>
        );
    }
  };

  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: s, height: s }}>{glyph()}</View>;
}

/** Maps a navigation destination to its icon, so the sidebar and tab bar stay consistent. */
export const navIcon = (href: string): IconName => {
  if (href === "/") return "home";
  if (href === "/sell") return "cart";
  if (href === "/stock") return "layers";
  if (href === "/expense") return "receipt";
  if (href === "/reports") return "chart";
  if (href === "/approvals") return "checkSquare";
  if (href === "/sync") return "sync";
  if (href === "/settings") return "settings";
  if (href.startsWith("/admin")) return "shield";
  if (href === "/team") return "users";
  return "more";
};
