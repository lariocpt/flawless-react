import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, TextInput, TouchableOpacity, View } from "react-native";

interface NativeA11yOffenderProps {
  onSend: () => void;
  onSave: () => void;
  onQuit: () => void;
  onToggle: () => void;
  onBell: () => void;
  onRow: () => void;
  onDot: () => void;
  title: string;
}

/**
 * The native peer of A11yOffender.tsx: one planted violation per rule the
 * native a11y analyser ships, each on its own element with a unique anchor so
 * the mutation probes can one-line-fix exactly one of them.
 *
 * Expected census: 2 unnamed-control (send + bell — a testID is not a name),
 * 5 missing-role (send, save, bell, row, year), 1 textinput-unlabelled,
 * 1 icon-unhidden (the free-standing alert icon), 1 label-text-mismatch,
 * 1 invalid-role. Eleven findings; tests/a11yNative.test.ts pins the counts.
 */
export function NativeA11yOffender({
  onSend,
  onSave,
  onQuit,
  onToggle,
  onBell,
  onRow,
  onDot,
  title,
}: NativeA11yOffenderProps) {
  const year = "2026";
  return (
    <View>
      {/* unnamed-control + missing-role: icon-only, nothing names it */}
      <Pressable onPress={onSend}>
        <Ionicons name="send" size={24} />
      </Pressable>
      {/* missing-role only: the text names it, but nothing says it is a button */}
      <Pressable onPress={onSave}>
        <Text>Save profile</Text>
      </Pressable>
      {/* textinput-unlabelled: a placeholder is not a label */}
      <TextInput placeholder="Email" />
      {/* icon-unhidden: free-standing and decorating nothing */}
      <Ionicons name="alert-circle" size={16} />
      {/* label-text-mismatch: voice-control users say "Sign out" and nothing happens */}
      <Pressable accessibilityLabel="Submit" accessibilityRole="button" onPress={onQuit}>
        <Text>Sign out</Text>
      </Pressable>
      {/* invalid-role: "heading" is a `role` value; the accessibilityRole spelling is "header" */}
      <TouchableOpacity accessibilityLabel="Section" accessibilityRole="heading" onPress={onToggle}>
        <Ionicons name="chevron-down" size={12} />
      </TouchableOpacity>
      {/* the testID asymmetry: addressable to a spec, still silent to a screen reader */}
      <Pressable testID="bell" onPress={onBell}>
        <Ionicons name="notifications" size={20} />
      </Pressable>
      {/* dynamic children: unaddressable to a spec, but NOT provably unnamed —
          `{title}` announces at runtime, so unnamed-control must stay quiet here */}
      <Pressable onPress={onRow}>
        <Text>{title}</Text>
      </Pressable>
      {/* a local interpolation: no rung can address it AND no finding may call it
          unnamed — the ladder skip and the census restraint are the same fact */}
      <Pressable onPress={onDot}>
        <Text>{year}</Text>
      </Pressable>
    </View>
  );
}
