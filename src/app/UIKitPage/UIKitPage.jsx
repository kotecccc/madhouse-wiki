import { Divider } from "../../components/ui/Divider/Divider.jsx";
import { useState } from "react";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { ContentSection } from "../../components/ui/ContentSection/ContentSection.jsx";
import { Dialog } from "../../components/ui/Dialog/Dialog.jsx";
import { DialogCloseButton } from "../../components/ui/DialogCloseButton/DialogCloseButton.jsx";
import { FieldLabel } from "../../components/ui/FieldLabel/FieldLabel.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Input } from "../../components/ui/Input/Input.jsx";
import { Modal } from "../../components/ui/Modal/Modal.jsx";
import { MonoLabel } from "../../components/ui/MonoLabel/MonoLabel.jsx";
import { NumberField } from "../../components/ui/NumberField/NumberField.jsx";
import { NumberStepper } from "../../components/ui/NumberStepper/NumberStepper.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { ProgressBar } from "../../components/ui/ProgressBar/ProgressBar.jsx";
import { SelectField } from "../../components/ui/SelectField/SelectField.jsx";
import { Title } from "../../components/ui/Title/Title.jsx";
import { EntityConstructors } from "./EntityConstructors.jsx";
import "./UIKitPage.css";

const cardVariants = [
  { name: "Base" },
  { name: "Image", variant: "image" },
  { name: "Popover", variant: "popover" },
  { name: "Token help", variant: "token-help" },
];

const buttonVariants = [
  { name: "Primary", variant: "primary" },
  { name: "Secondary", variant: "secondary" },
  { name: "Card action", variant: "card-action", icon: "external-link" },
  { name: "Toggle", variant: "toggle", state: "toggle" },
  { name: "Tab", variant: "nav-tab", state: "selected" },
  { name: "Icon only", variant: "icon-copy", icon: "copy" },
  { name: "Inline icon only", variant: "icon-copy-inline", icon: "copy" },
];

const iconTypes = [
  "boss",
  "character",
  "chevron",
  "external-link",
  "message",
  "copy",
  "loot",
  "levels",
  "lock",
  "unlock",
  "business",
  "bug",
  "department",
  "floor",
  "combat",
  "fist",
  "fire",
  "timer",
  "energy",
  "dice",
  "stash",
  "book",
  "calc",
  "coin",
  "pill",
  "banknote",
];
const sampleBossPortrait = knowledgeBase.bosses.find(
  (boss) => Number(boss.apiId) === 49,
);

const colorTokens = [
  { name: "Page", token: "--surface-page", color: "var(--surface-page)" },
  { name: "Inset", token: "--surface-inset", color: "var(--surface-inset)" },
  { name: "Raised", token: "--surface-raised", color: "var(--surface-raised)" },
  { name: "Card", token: "--card-background", color: "var(--card-background)" },
  { name: "Text", token: "--text-primary", color: "var(--text-primary)" },
  { name: "Accent", token: "--red", color: "var(--red)" },
  {
    name: "Success",
    token: "--status-completed",
    color: "var(--status-completed)",
  },
  {
    name: "Warning",
    token: "--status-business",
    color: "var(--status-business)",
  },
  { name: "Energy", token: "--icon-energy", color: "var(--icon-energy)" },
];

const spacingTokens = [
  ["4", "--space-unit"],
  ["8", "--space-8"],
  ["12", "--space-12"],
  ["16", "--space-16"],
  ["24", "--space-24"],
  ["32", "--space-32"],
  ["40", "--space-40"],
  ["48", "--space-48"],
  ["64", "--space-64"],
];

const fontTokens = [
  ["10 px", "--font-size-2xs"],
  ["12 px", "--font-size-xs"],
  ["14 px", "--font-size-sm"],
  ["16 px", "--font-size-md"],
  ["20 px", "--font-size-lg"],
  ["24 px", "--font-size-xl"],
  ["28 px", "--font-size-2xl"],
  ["32 px", "--font-size-3xl"],
  ["40 px", "--font-size-display"],
];

const statusVariants = [
  ["scheduled", "Scheduled"],
  ["active", "Active"],
  ["completed", "Completed"],
  ["locked", "Locked"],
  ["warning", "Warning"],
  ["unknown", "Unknown"],
];

function ComponentSection({ id, title, children }) {
  return (
    <section className="ui-kit-section" id={id}>
      <header className="ui-kit-section-heading">
        <Title as="h2">{title}</Title>
      </header>
      {children}
    </section>
  );
}

function ExamplePanel({ children, className = "" }) {
  return (
    <BaseCard className={`ui-kit-panel ${className}`.trim()}>
      {children}
    </BaseCard>
  );
}

function Property({ name, value }) {
  return (
    <span className="ui-kit-property">
      <code>{name}</code> {value}
    </span>
  );
}

export function UIKitPage() {
  const [activeKit, setActiveKit] = useState("ui");
  const [toggle, setToggle] = useState(false);
  const [stepperValue, setStepperValue] = useState(4);
  const [controlSize, setControlSize] = useState("md");
  const [controlDisabled, setControlDisabled] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [insetModalOpen, setInsetModalOpen] = useState(false);
  const [simpleModalOpen, setSimpleModalOpen] = useState(false);

  const switchKit = (kit) => {
    setActiveKit(kit);
    window.scrollTo(0, 0);
  };

  return (
    <div className="ui-kit-layout">
      <main className="ui-kit-main">
        <header className="ui-kit-topbar">
          <span className="ui-kit-brand">Madhouse</span>
          <nav className="ui-kit-kit-switch" aria-label="Design system kits">
            <Button
              size="sm"
              variant="nav-tab"
              aria-pressed={activeKit === "ui"}
              onClick={() => switchKit("ui")}
            >
              UI Kit
            </Button>
            <Button
              size="sm"
              variant="nav-tab"
              aria-pressed={activeKit === "business"}
              onClick={() => switchKit("business")}
            >
              Business Kit
            </Button>
          </nav>
        </header>

        <div className="ui-kit-content" key={activeKit}>
          {activeKit === "ui" ? (
            <>
              <ComponentSection id="foundations" title="Foundations">
                <ExamplePanel>
                  <div className="ui-kit-panel-heading">
                    <CardTitle>Colors</CardTitle>
                  </div>
                  <div className="ui-kit-color-grid">
                    {colorTokens.map((item) => (
                      <div className="ui-kit-color" key={item.token}>
                        <span style={{ "--swatch": item.color }} />
                        <strong>{item.name}</strong>
                        <code>{item.token}</code>
                      </div>
                    ))}
                  </div>
                </ExamplePanel>
                <div className="ui-kit-foundation-grid">
                  <ExamplePanel>
                    <div className="ui-kit-panel-heading">
                      <CardTitle>Spacing</CardTitle>
                    </div>
                    <div className="ui-kit-spacing-list">
                      {spacingTokens.map(([size, token]) => (
                        <div className="ui-kit-spacing-row" key={token}>
                          <code>{token}</code>
                          <span>
                            <i style={{ width: `var(${token})` }} />
                          </span>
                          <strong>{size}px</strong>
                        </div>
                      ))}
                    </div>
                  </ExamplePanel>
                  <ExamplePanel>
                    <div className="ui-kit-panel-heading">
                      <CardTitle>Shape & controls</CardTitle>
                    </div>
                    <div className="ui-kit-shape-row">
                      <div>
                        <span className="ui-kit-radius-sample" />
                        <strong>8 px</strong>
                        <small>Radius</small>
                      </div>
                      <div>
                        <span className="ui-kit-control-sample">40</span>
                        <strong>40 px</strong>
                        <small>Control</small>
                      </div>
                      <div>
                        <span className="ui-kit-control-sample ui-kit-control-sample--touch">
                          44
                        </span>
                        <strong>44 px</strong>
                        <small>Touch</small>
                      </div>
                    </div>
                  </ExamplePanel>
                </div>
              </ComponentSection>

              <ComponentSection id="surfaces" title="Surfaces">
                <ExamplePanel>
                  <div className="ui-kit-variant-grid">
                    {cardVariants.map(({ name, variant }) => (
                      <div
                        className="ui-kit-variant-item"
                        key={variant || "default"}
                      >
                        <MonoLabel>{name}</MonoLabel>
                        <BaseCard
                          variant={variant}
                          className="ui-kit-variant-card"
                        >
                          <div
                            className={
                              variant === "image"
                                ? "ui-kit-variant-copy ui-kit-variant-copy--inset"
                                : "ui-kit-variant-copy"
                            }
                          >
                            <CardTitle>Card title</CardTitle>
                            <CardDescription>Description</CardDescription>
                          </div>
                        </BaseCard>
                        <code>
                          {variant ? `variant="${variant}"` : "default"}
                        </code>
                      </div>
                    ))}
                  </div>
                </ExamplePanel>
                <ExamplePanel>
                  <BaseCard className="ui-kit-text-role-sample">
                    <CardTitle>Card title</CardTitle>
                    <CardDescription>Card description</CardDescription>
                  </BaseCard>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="buttons" title="Controls">
                <ExamplePanel>
                  <div className="ui-kit-panel-heading">
                    <CardTitle>Buttons</CardTitle>
                  </div>
                  <div className="ui-kit-button-grid">
                    {buttonVariants.map(({ name, variant, icon, state }) => (
                      <div className="ui-kit-button-sample" key={variant}>
                        <MonoLabel>{name}</MonoLabel>
                        <Button
                          variant={variant}
                          aria-pressed={
                            state === "toggle" ? toggle : state === "selected"
                          }
                          onClick={
                            state === "toggle"
                              ? () => setToggle(!toggle)
                              : undefined
                          }
                          icon={icon}
                        >
                          {name}
                        </Button>
                      </div>
                    ))}
                  </div>
                </ExamplePanel>
                <ExamplePanel className="ui-kit-control-playground">
                  <div className="ui-kit-control-toolbar">
                    <div>
                      <MonoLabel>Size</MonoLabel>
                      <div
                        className="ui-kit-control-size-switch"
                        role="group"
                        aria-label="Control size"
                      >
                        {["sm", "md", "lg"].map((size) => (
                          <Button
                            key={size}
                            size="sm"
                            variant="nav-tab"
                            aria-pressed={controlSize === size}
                            onClick={() => setControlSize(size)}
                          >
                            {size.toUpperCase()}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <Button
                      variant="toggle"
                      aria-pressed={controlDisabled}
                      onClick={() => setControlDisabled((current) => !current)}
                    >
                      {controlDisabled ? "✓ " : ""}Disabled
                    </Button>
                  </div>
                  <div className="ui-kit-control-preview-grid">
                    <div className="ui-kit-control-preview-item">
                      <MonoLabel>Button</MonoLabel>
                      <Button size={controlSize} disabled={controlDisabled}>
                        Primary action
                      </Button>
                    </div>
                    <div className="ui-kit-control-preview-item">
                      <MonoLabel>Input</MonoLabel>
                      <Input
                        id="kit-playground-input"
                        size={controlSize}
                        disabled={controlDisabled}
                        placeholder="Text"
                      />
                    </div>
                    <div className="ui-kit-control-preview-item">
                      <MonoLabel>SelectField</MonoLabel>
                      <SelectField
                        id="kit-playground-select"
                        size={controlSize}
                        spacing="none"
                        disabled={controlDisabled}
                        label="Option"
                        options={[
                          { id: "option-1", value: "1", label: "Option 1" },
                          { id: "option-2", value: "2", label: "Option 2" },
                        ]}
                      />
                    </div>
                    <div className="ui-kit-control-preview-item">
                      <MonoLabel>NumberField</MonoLabel>
                      <NumberField
                        id="kit-playground-number"
                        size={controlSize}
                        spacing="none"
                        disabled={controlDisabled}
                        label="Count"
                        suffix="items"
                        defaultValue={12}
                      />
                    </div>
                  </div>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="typography" title="Typography">
                <ExamplePanel className="ui-kit-type-panel">
                  <div className="ui-kit-type-samples">
                    {[
                      ["h1", "Display / 40 px"],
                      ["h2", "Heading / 32 px"],
                      ["h3", "Title / 24 px"],
                      ["h4", "Subtitle / 20 px"],
                      ["h5", "Body strong / 16 px"],
                      ["h6", "Label / 14 px"],
                    ].map(([level, label]) => (
                      <div className="ui-kit-type-row" key={level}>
                        <code>{label}</code>
                        <Title as={level}>Heading {level}</Title>
                      </div>
                    ))}
                  </div>
                  <div className="ui-kit-font-scale" aria-label="Font scale">
                    {fontTokens.map(([size, token]) => (
                      <div
                        key={token}
                        style={{ "--sample-font-size": `var(${token})` }}
                      >
                        <span aria-hidden="true">Aa</span>
                        <code>
                          {size} • {token}
                        </code>
                      </div>
                    ))}
                  </div>
                  <div className="ui-kit-panel-heading">
                    <MonoLabel>MONOLABEL</MonoLabel>
                    <CardTitle>Card title</CardTitle>
                    <CardDescription>Card description</CardDescription>
                  </div>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="fields" title="Fields">
                <ExamplePanel>
                  <div className="ui-kit-form-grid">
                    <NumberStepper
                      id="kit-stepper"
                      label="NumberStepper"
                      min={1}
                      max={10}
                      value={stepperValue}
                      onChange={setStepperValue}
                      decrementLabel="Decrease"
                      incrementLabel="Increase"
                      rangeLabel="Range 1–10"
                    />
                  </div>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="media-icons" title="Media & icons">
                <ExamplePanel>
                  <div className="ui-kit-panel-heading">
                    <CardTitle>ImageCard</CardTitle>
                  </div>
                  <div className="ui-kit-image-grid">
                    <div>
                      <ImageCard
                        label="Default"
                        size="var(--content-image-size)"
                      />
                      <MonoLabel>content image size</MonoLabel>
                    </div>
                    <div>
                      <ImageCard
                        label="Large"
                        size="var(--space-64)"
                        imageSize="var(--content-image-size)"
                      />
                      <MonoLabel>64 px • large</MonoLabel>
                    </div>
                    <div>
                      <ImageCard
                        label="Fallback slot"
                        size="var(--content-image-size)"
                      >
                        <Icon type="boss" size="medium" />
                      </ImageCard>
                      <MonoLabel>fallback content slot</MonoLabel>
                    </div>
                    <div>
                      <ImageCard
                        label="Failed image"
                        src="data:image/png;base64,not-valid"
                        size="var(--content-image-size)"
                      />
                      <MonoLabel>failed image</MonoLabel>
                    </div>
                    <div>
                      <ImageCard
                        label={`Boss portrait: ${sampleBossPortrait?.name || "Криворог"}`}
                        alt={sampleBossPortrait?.name || "Криворог"}
                        src={
                          sampleBossPortrait?.image ||
                          "https://cdn.cargohustle.online/V3/floor/bosses/prew/P49.webp"
                        }
                        size="var(--content-image-size)"
                        loading="eager"
                      />
                      <MonoLabel>Boss portrait • P49</MonoLabel>
                    </div>
                  </div>
                </ExamplePanel>
                <ExamplePanel>
                  <div className="ui-kit-panel-heading">
                    <CardTitle>Icon</CardTitle>
                  </div>
                  <div className="ui-kit-icon-size-row">
                    <Icon type="floor" size="small" />
                    <Icon type="floor" size="medium" />
                    <Icon type="floor" size="large" />
                    <span>
                      <code>small • medium • large</code>
                    </span>
                  </div>
                  <div className="ui-kit-icon-grid">
                    {iconTypes.map((type) => (
                      <div key={type}>
                        <Icon type={type} size="medium" />
                        <span>{type}</span>
                      </div>
                    ))}
                  </div>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="divider" title="Divider">
                <ExamplePanel>
                  <CardDescription>Содержимое</CardDescription>
                  <Divider />
                  <CardDescription>Итого</CardDescription>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="feedback" title="Feedback">
                <ExamplePanel>
                  <div className="ui-kit-panel-heading">
                    <CardTitle>ProgressBar</CardTitle>
                  </div>
                  <ProgressBar
                    value={3}
                    max={5}
                    segments={5}
                    label="ProgressBar preview"
                    valueText="3 of 5"
                  />
                  <div className="ui-kit-panel-heading">
                    <CardTitle>Pill</CardTitle>
                  </div>
                  <div className="ui-kit-pill-grid">
                    {statusVariants.map(([variant, label]) => (
                      <div key={variant}>
                        <Pill variant={variant}>{label}</Pill>
                        <code>{variant}</code>
                      </div>
                    ))}
                  </div>
                  <div className="ui-kit-row">
                    <Pill variant="active" dot={false}>
                      No dot
                    </Pill>
                    <Pill variant="warning" dot={false}>
                      No dot
                    </Pill>
                  </div>
                </ExamplePanel>
              </ComponentSection>

              <ComponentSection id="overlays" title="Overlays">
                <div className="ui-kit-foundation-grid">
                  <ExamplePanel>
                    <div className="ui-kit-panel-heading">
                      <CardTitle>Dialog</CardTitle>
                    </div>
                    <div className="ui-kit-row">
                      <Button onClick={() => setDialogOpen(true)}>
                        Open dialog
                      </Button>
                    </div>
                    <Dialog
                      modal
                      surface="token-help"
                      visible={dialogOpen}
                      aria-labelledby="kit-dialog-title"
                      onClose={() => setDialogOpen(false)}
                    >
                      <div className="ui-kit-dialog-content">
                        <div className="ui-kit-dialog-heading">
                          <Title as="h3" id="kit-dialog-title">
                            Dialog
                          </Title>
                          <DialogCloseButton
                            onClick={() => setDialogOpen(false)}
                          />
                        </div>
                        <Button onClick={() => setDialogOpen(false)}>
                          Close
                        </Button>
                      </div>
                    </Dialog>
                  </ExamplePanel>
                  <ExamplePanel>
                    <div className="ui-kit-panel-heading">
                      <CardTitle>Modal</CardTitle>
                    </div>
                    <div className="ui-kit-row">
                      <Button onClick={() => setModalOpen(true)}>
                        Default
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setInsetModalOpen(true)}
                      >
                        Inset
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setSimpleModalOpen(true)}
                      >
                        No footer
                      </Button>
                    </div>
                    <div className="ui-kit-property-row">
                      <Property name="width" value="520 px default • custom" />
                      <Property name="footer" value="shown • omitted" />
                      <Property name="contentVariant" value="default • inset" />
                    </div>
                    <Modal
                      title="Default modal"
                      description="Modal description"
                      visible={modalOpen}
                      onClose={() => setModalOpen(false)}
                      footer={
                        <Button onClick={() => setModalOpen(false)}>
                          Done
                        </Button>
                      }
                    >
                      Modal content
                    </Modal>
                    <Modal
                      title="Inset content"
                      visible={insetModalOpen}
                      onClose={() => setInsetModalOpen(false)}
                      contentVariant="inset"
                      contentScrollable={false}
                      footer={
                        <Button onClick={() => setInsetModalOpen(false)}>
                          Close
                        </Button>
                      }
                    >
                      Modal content
                    </Modal>
                    <Modal
                      title="Compact modal"
                      width={640}
                      visible={simpleModalOpen}
                      onClose={() => setSimpleModalOpen(false)}
                    >
                      Modal content
                    </Modal>
                  </ExamplePanel>
                </div>
              </ComponentSection>

              <ComponentSection id="composition" title="Composition">
                <ExamplePanel>
                  <ContentSection className="ui-kit-content-section-sample">
                    <div>
                      <MonoLabel>CONTENT SECTION</MonoLabel>
                      <Title as="h3">Section title</Title>
                      <p>Content</p>
                      <Button>Primary action</Button>
                    </div>
                  </ContentSection>
                </ExamplePanel>
              </ComponentSection>
            </>
          ) : (
            <EntityConstructors />
          )}
        </div>
      </main>
    </div>
  );
}
