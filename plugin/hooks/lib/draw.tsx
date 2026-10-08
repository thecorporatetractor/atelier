import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

export type Els = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

export function drawHello(els: Els, act: { bump: () => void }): RenderElement {
  const { Box, Text, Button } = els

  return (
    <Box key="hello" flexDirection="row">
      <Text>Hello </Text>
      <Button key="bump" label="bump" onPress={act.bump} />
    </Box>
  )
}
