import { Ionicons } from "@expo/vector-icons";
import { Pressable, TextInput, View } from "react-native";

interface NativeA11yDynamicProps {
  label: string;
  kind: "button" | "link";
  onGo: () => void;
}

/**
 * The precision control: every accessibility attribute here is REAL but not a
 * string literal, so the census can record presence and nothing else. Every
 * rule must stand down — zero findings over a non-zero denominator — because a
 * finding against `accessibilityLabel={label}` would be a guess about a value
 * the analyser cannot read. A miss costs coverage; a guess costs a false
 * finding.
 */
export function NativeA11yDynamic({ label, kind, onGo }: NativeA11yDynamicProps) {
  return (
    <View>
      <Pressable accessibilityLabel={label} accessibilityRole={kind} onPress={onGo}>
        <Ionicons name="send" size={24} />
      </Pressable>
      <TextInput accessibilityLabel={label} placeholder="Email" />
    </View>
  );
}
