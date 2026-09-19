# Tài Liệu Đặc Tả API sdcpp (Stable Diffusion C++)

Tài liệu này tổng hợp toàn bộ các endpoint, cấu trúc request/response, và hướng dẫn tích hợp cho máy chủ `sd-server` thuộc dự án [`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp).

---

## 1. Tổng Quan Về Kiến Trúc API

`sd-server` cung cấp 3 bộ API song song:

1. **`sdcpp API` (`/sdcpp/v1/*`)** — **API Native (Chính chủ & Bất đồng bộ)**:
   - Được thiết kế riêng cho `stable-diffusion.cpp`.
   - Hỗ trợ mô hình Job Queue bất đồng bộ (`queued` ➔ `generating` ➔ `completed` / `failed` / `cancelled`).
   - Cung cấp toàn quyền kiểm soát các tham số nội bộ: VAE tiling, sampling methods, schedulers, distilled guidance, SLG, clip skip,...
2. **`WebUI API` (`/sdapi/v1/*`)** — **Tương thích AUTOMATIC1111 / WebUI** (Đồng bộ).
3. **`OpenAI API` (`/v1/*`)** — **Tương thích OpenAI Images API** (Đồng bộ).

---

## 2. Đặc Tả Chi Tiết Bộ API Native: `/sdcpp/v1/*`

### 2.1. Lấy thông tin khả năng & Model: `GET /sdcpp/v1/capabilities`

Endpoint này trả về toàn bộ thông tin cấu hình hiện tại của máy chủ và mô hình đã được tải vào bộ nhớ.

- **Method**: `GET`
- **URL**: `http://<host>:<port>/sdcpp/v1/capabilities`
- **Headers**: Không yêu cầu

#### Cấu trúc Response (JSON)

```json
{
  "current_mode": "img_gen",
  "supported_modes": ["img_gen"],
  "model": {
    "name": "realisticVisionV60B1_v51VAE.safetensors",
    "path": ".\\realisticVisionV60B1_v51VAE.safetensors",
    "stem": "realisticVisionV60B1_v51VAE"
  },
  "samplers": [
    "euler", "euler_a", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2",
    "ipndm", "ipndm_v", "lcm", "ddim_trailing", "tcd", "res_multistep",
    "res_2s", "er_sde", "euler_cfg_pp", "euler_a_cfg_pp", "euler_ge",
    "dpm++2m_sde", "dpm++2m_sde_bt", "lms"
  ],
  "schedulers": [
    "discrete", "normal", "karras", "exponential", "ays", "gits",
    "sgm_uniform", "simple", "smoothstep", "kl_optimal", "lcm",
    "bong_tangent", "ltx2", "logit_normal", "flux2", "flux", "beta"
  ],
  "loras": [
    { "name": "LCM_LoRA_Weights_SD15", "path": "LCM_LoRA_Weights_SD15.safetensors" }
  ],
  "limits": {
    "min_width": 64,
    "max_width": 4096,
    "min_height": 64,
    "max_height": 4096,
    "max_batch_count": 8,
    "max_queue_size": 64
  },
  "defaults_by_mode": {
    "img_gen": {
      "prompt": "",
      "negative_prompt": "",
      "width": 512,
      "height": 512,
      "seed": 42,
      "batch_count": 1,
      "clip_skip": -1,
      "sample_params": {
        "sample_method": "default",
        "sample_steps": 20,
        "scheduler": "default",
        "guidance": {
          "txt_cfg": 7.0,
          "distilled_guidance": 3.5
        }
      },
      "vae_tiling_params": {
        "enabled": false,
        "target_overlap": 0.5
      }
    }
  }
}
```

---

### 2.2. Gửi tác vụ sinh ảnh: `POST /sdcpp/v1/img_gen`

Gửi yêu cầu tạo ảnh. Máy chủ tiếp nhận và trả về trạng thái `202 Accepted` cùng ID tác vụ.

- **Method**: `POST`
- **URL**: `http://<host>:<port>/sdcpp/v1/img_gen`
- **Headers**: `Content-Type: application/json`

#### Cấu trúc Request Body

```json
{
  "prompt": "a beautiful landscape, 8k resolution",
  "negative_prompt": "blurry, low quality, distorted",
  "width": 512,
  "height": 512,
  "clip_skip": -1,
  "seed": -1,
  "batch_count": 1,
  "sample_params": {
    "scheduler": "discrete",
    "sample_method": "euler_a",
    "sample_steps": 20,
    "guidance": {
      "txt_cfg": 7.0
    }
  },
  "vae_tiling_params": {
    "enabled": true,
    "temporal_tiling": false,
    "tile_size_x": 0,
    "tile_size_y": 0,
    "target_overlap": 0.5,
    "rel_size_x": 0.0,
    "rel_size_y": 0.0,
    "extra_tiling_args": ""
  },
  "output_format": "png",
  "output_compression": 100
}
```

#### Giải thích các tham số quan trọng:

| Tham số | Kiểu | Mô tả |
| :--- | :--- | :--- |
| `prompt` | `string` | *(Bắt buộc)* Câu lệnh mô tả ảnh cần sinh |
| `negative_prompt` | `string` | Nội dung cần loại bỏ trong ảnh |
| `width`, `height` | `number` | Kích thước ảnh (bội số của 64) |
| `seed` | `number` | Seed số ngẫu nhiên (-1 là sinh ngẫu nhiên) |
| `batch_count` | `number` | Số lượng ảnh sinh ra (tối đa theo `limits.max_batch_count`) |
| `clip_skip` | `number` | Số layer CLIP bỏ qua (-1 là mặc định của model) |
| `sample_params.sample_method` | `string` | Tên sampler (ví dụ: `euler`, `euler_a`, `dpm++2m`,...) |
| `sample_params.scheduler` | `string` | Tên scheduler (ví dụ: `discrete`, `karras`, `normal`,...) |
| `sample_params.sample_steps` | `number` | Số bước lấy mẫu (steps) |
| `sample_params.guidance.txt_cfg`| `number` | Hệ số tuân thủ prompt (CFG scale, thường từ 5.0 - 9.0) |
| `vae_tiling_params.enabled` | `boolean` | **Bật chia nhỏ VAE tiling** (giảm thiểu VRAM, tránh OOM khi sinh ảnh lớn) |
| `output_format` | `string` | Định dạng trả về: `"png"`, `"jpeg"`, hoặc `"webp"` |

#### Response khi gửi thành công (`202 Accepted`):

```json
{
  "id": "job_01HTXYZABC",
  "kind": "img_gen",
  "status": "queued",
  "created": 1775401200,
  "poll_url": "/sdcpp/v1/jobs/job_01HTXYZABC"
}
```

---

### 2.3. Lấy trạng thái & kết quả Job: `GET /sdcpp/v1/jobs/{id}`

- **Method**: `GET`
- **URL**: `http://<host>:<port>/sdcpp/v1/jobs/{id}`

#### Vòng đời trạng thái (`status`):
- `queued`: Tác vụ đang chờ trong hàng đợi.
- `generating`: Đang chạy mô hình sinh ảnh.
- `completed`: Đã hoàn thành, dữ liệu ảnh sẵn sàng.
- `failed`: Tác vụ gặp lỗi.
- `cancelled`: Tác vụ đã bị hủy bởi client.

#### Response khi hoàn thành (`completed`):

```json
{
  "id": "job_01HTXYZABC",
  "kind": "img_gen",
  "status": "completed",
  "created": 1775401200,
  "started": 1775401203,
  "completed": 1775401215,
  "queue_position": 0,
  "result": {
    "output_format": "png",
    "images": [
      {
        "index": 0,
        "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..."
      }
    ]
  },
  "error": null
}
```

#### Response khi gặp lỗi (`failed`):

```json
{
  "id": "job_01HTXYZABC",
  "kind": "img_gen",
  "status": "failed",
  "result": null,
  "error": {
    "code": "generation_failed",
    "message": "Chi tiết lỗi từ sd-server"
  }
}
```

---

### 2.4. Hủy bỏ tác vụ: `POST /sdcpp/v1/jobs/{id}/cancel`

- **Method**: `POST`
- **URL**: `http://<host>:<port>/sdcpp/v1/jobs/{id}/cancel`

---

### 2.5. Sinh video: `POST /sdcpp/v1/vid_gen`

Hỗ trợ các mô hình Video Diffusion như Wan, LTX, SVD. Tương tự `img_gen` nhưng bổ sung các tham số video: `video_frames`, `fps`, `control_frames`, v.v.

---

## 3. WebUI Compatibility API: `/sdapi/v1/*`

Dành cho các công cụ tương thích chuẩn AUTOMATIC1111:

- `POST /sdapi/v1/txt2img`: Sinh ảnh từ text (đồng bộ).
- `POST /sdapi/v1/img2img`: Sinh ảnh từ ảnh gốc (đồng bộ).
- `GET /sdapi/v1/sd-models`: Danh sách các model checkpoint.
- `GET /sdapi/v1/samplers`: Danh sách sampler.
- `GET /sdapi/v1/schedulers`: Danh sách scheduler.
- `GET /sdapi/v1/loras`: Danh sách LoRA.
- `GET /sdapi/v1/upscalers`: Danh sách bộ upscale.

---

## 4. OpenAI Compatibility API: `/v1/*`

Dành cho các SDK hỗ trợ chuẩn OpenAI Image:

- `POST /v1/images/generations`: `{ "prompt": "...", "size": "512x512", "n": 1 }`
- `POST /v1/images/edits`: Hỗ trợ inpainting / image edits.
- `GET /v1/models`: Danh sách model.

---

## 5. Lưu Ý Kỹ Thuật Quan Trọng

1. **Tránh Escape Lỗi Trên Windows CLI / PowerShell:**
   - Trên PowerShell, việc escape chuỗi JSON qua `-d "{\"key\":\"value\"}"` dễ bị PowerShell phân tách khoảng trắng khiến `curl.exe` nhận JSON bị cắt ngắn.
   - Khi server C++ nhận một payload HTTP POST bị cắt đứt giữa chừng hoặc socket bị đóng đột ngột, tiến trình có thể bị abort/crash nếu thư viện HTTP parser không có ngoại lệ bọc kín.
   - **Khuyến nghị**: Khi gọi API bằng code (Node.js/Fetch/Axios), luôn sử dụng `JSON.stringify(payload)` và set header `Content-Type: application/json; charset=utf-8` chuẩn xác.
2. **Quy tắc LoRA:**
   - Cú pháp prompt `<lora:...>` không được server parse trực tiếp.
   - Phải truyền mảng cấu trúc qua trường `lora: [{ "path": "ten_lora.safetensors", "multiplier": 0.8 }]`.
3. **VAE Tiling:**
   - Luôn bật `vae_tiling_params.enabled = true` khi sinh ảnh kích thước lớn từ 512x512 trở lên để tránh tràn bộ nhớ VRAM.
