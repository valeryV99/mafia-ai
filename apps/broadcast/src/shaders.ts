const SHADER_HEADER = `
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
}

struct BaseShaderParameters {
    plane_id: i32,
    time: f32,
    output_resolution: vec2<u32>,
    texture_count: u32,
}

@group(0) @binding(0) var textures: binding_array<texture_2d<f32>, 16>;
@group(2) @binding(0) var sampler_: sampler;
var<push_constant> base_params: BaseShaderParameters;

@vertex fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4(input.position, 1.0);
    output.tex_coords = input.tex_coords;
    return output;
}
`

export const GRAYSCALE_SHADER = `${SHADER_HEADER}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (base_params.texture_count < 1u) {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }
    let color = textureSample(textures[0], sampler_, input.tex_coords);
    let gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    return vec4(vec3(gray), color.a);
}
`

export const NIGHT_SHADER = `${SHADER_HEADER}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (base_params.texture_count < 1u) {
        return vec4(0.0, 0.0, 0.05, 1.0);
    }
    let texel = vec2<f32>(1.0) / vec2<f32>(base_params.output_resolution);
    let spread = 6.0;
    // 5x5 Gaussian blur
    let o0 = -2.0 * spread; let o1 = -1.0 * spread; let o2 = 0.0; let o3 = 1.0 * spread; let o4 = 2.0 * spread;
    let w0 = 0.0625; let w1 = 0.25; let w2 = 0.375;
    var acc = vec4<f32>(0.0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o0) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o1) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o2) * texel) * (w0 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o3) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o4) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o0) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o1) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o2) * texel) * (w1 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o3) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o4) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o0) * texel) * (w2 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o1) * texel) * (w2 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o2) * texel) * (w2 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o3) * texel) * (w2 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o4) * texel) * (w2 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o0) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o1) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o2) * texel) * (w1 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o3) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o4) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o0) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o1) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o2) * texel) * (w0 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o3) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o4) * texel) * (w0 * w0);
    let darkened = acc.rgb * 0.3;
    let night_tint = vec3(darkened.r * 0.7, darkened.g * 0.8, darkened.b * 1.2 + 0.05);
    return vec4(night_tint, acc.a);
}
`

export const BLUR_SHADER = `${SHADER_HEADER}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (base_params.texture_count < 1u) {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }
    let texel = vec2<f32>(1.0) / vec2<f32>(base_params.output_resolution);
    let spread = 6.0;
    let o0 = -2.0 * spread; let o1 = -1.0 * spread; let o2 = 0.0; let o3 = 1.0 * spread; let o4 = 2.0 * spread;
    let w0 = 0.0625; let w1 = 0.25; let w2 = 0.375;
    var acc = vec4<f32>(0.0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o0) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o1) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o2) * texel) * (w0 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o3) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o0, o4) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o0) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o1) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o2) * texel) * (w1 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o3) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o1, o4) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o0) * texel) * (w2 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o1) * texel) * (w2 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o2) * texel) * (w2 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o3) * texel) * (w2 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o2, o4) * texel) * (w2 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o0) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o1) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o2) * texel) * (w1 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o3) * texel) * (w1 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o3, o4) * texel) * (w1 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o0) * texel) * (w0 * w0);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o1) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o2) * texel) * (w0 * w2);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o3) * texel) * (w0 * w1);
    acc += textureSample(textures[0], sampler_, input.tex_coords + vec2(o4, o4) * texel) * (w0 * w0);
    return vec4(acc.rgb, acc.a);
}
`

export const STRESS_SHADER = `${SHADER_HEADER}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (base_params.texture_count < 1u) {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }
    let color = textureSample(textures[0], sampler_, input.tex_coords);
    // Pulsating red tint based on time
    let pulse = sin(base_params.time * 4.0) * 0.5 + 0.5;
    let red_boost = pulse * 0.15;
    let tinted = vec3(
        min(1.0, color.r + red_boost),
        color.g * (1.0 - red_boost * 0.5),
        color.b * (1.0 - red_boost * 0.5)
    );
    return vec4(tinted, color.a);
}
`
