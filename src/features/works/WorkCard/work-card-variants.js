export const workCardVariants = Object.freeze({
  "work-main": {
    desktop: {
      descriptionFields: ["stash"],
      descriptionSize: "xs",
    },
    mobile: {
      descriptionFields: ["stash"],
      descriptionSize: "2xs",
      titleSize: "sm",
      buttonSize: "md",
    },
  },
});

export function getWorkCardVariantProps(key, mobile = false) {
  const settings = workCardVariants[key]?.[mobile ? "mobile" : "desktop"];
  if (!settings) return undefined;

  return {
    ...settings,
    descriptionFields: [...settings.descriptionFields],
  };
}
