export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

export const RoundedBorder = {
  border: ["top" as const, "bottom" as const, "left" as const, "right" as const],
  customBorderChars: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    bottomT: "┴",
    topT: "┬",
    cross: "┼",
    leftT: "├",
    rightT: "┤",
  },
}

export const SolidBorder = {
  border: ["top" as const, "bottom" as const, "left" as const, "right" as const],
  customBorderChars: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    bottomT: "┴",
    topT: "┬",
    cross: "┼",
    leftT: "├",
    rightT: "┤",
  },
}
