# Adapted from no1yu/HivisionIDPhotosPro, Apache-2.0.
# Commit: 741e7c6215e3bc312ad8cec95b51bf5b16e36a0b
# Changes: explicit measured chin input; geometry output for local HD composition.
import cv2
import numpy as np
MIN_CLOTHES_DETAIL_WIDTH=512

def _resize_bgra(image: np.ndarray, width: int, height: int) -> np.ndarray:
    """使用预乘Alpha缩放透明图层"""
    normalized = image.astype(np.float32) / 255.0
    alpha = normalized[:, :, 3:4]
    premultiplied_color = normalized[:, :, :3] * alpha
    resized_color = cv2.resize(
        premultiplied_color,
        (width, height),
        interpolation=cv2.INTER_LANCZOS4,
    )
    resized_alpha = cv2.resize(
        alpha,
        (width, height),
        interpolation=cv2.INTER_LANCZOS4,
    )
    if resized_alpha.ndim == 2:
        resized_alpha = resized_alpha[:, :, None]

    output_color = np.divide(
        resized_color,
        resized_alpha,
        out=np.zeros_like(resized_color),
        where=resized_alpha > 0,
    )
    return np.uint8(
        np.clip(
            np.concatenate((output_color, resized_alpha), axis=2) * 255.0,
            0,
            255,
        )
    )

def _find_center_span(row_mask: np.ndarray, center_x: int, search_radius: int):
    """返回当前行最靠近人物中心的连续有效区间"""
    image_width = row_mask.shape[0]
    center_x = int(np.clip(center_x, 0, image_width - 1))
    if row_mask[center_x]:
        seed_x = center_x
    else:
        left = max(0, center_x - search_radius)
        right = min(image_width, center_x + search_radius + 1)
        candidates = np.flatnonzero(row_mask[left:right]) + left
        if candidates.size == 0:
            return None
        seed_x = int(candidates[np.argmin(np.abs(candidates - center_x))])

    span_left = seed_x
    span_right = seed_x
    while span_left > 0 and row_mask[span_left - 1]:
        span_left -= 1
    while span_right + 1 < image_width and row_mask[span_right + 1]:
        span_right += 1
    return span_left, span_right

def _measure_neck_geometry(
    input_image: np.ndarray,
    face: np.ndarray,
    parsing_probabilities: np.ndarray,
    measured_chin_y: float,
) -> dict:
    """以嘴部关键点约束下巴位置，测量连续可用颈部和皮肤下沿"""
    image_height, image_width = input_image.shape[:2]
    face_x, face_y, face_width, face_height = [float(value) for value in face[:4]]
    center_x = face_x + face_width / 2.0
    face_bottom = face_y + face_height
    landmark_chin_y = float(measured_chin_y)

    band_left = max(0, round(center_x - face_width * 0.14))
    band_right = min(image_width, round(center_x + face_width * 0.14) + 1)
    face_probability = parsing_probabilities[:, :, 3]
    body_probability = parsing_probabilities[:, :, 2]
    skin_probability = np.clip(face_probability + body_probability, 0.0, 1.0)
    original_alpha = input_image[:, :, 3].astype(np.float32) / 255.0

    transition_start = int(
        np.clip(round(face_y + face_height * 0.75), 0, image_height - 1)
    )
    transition_end = int(
        np.clip(
            round(face_bottom + face_height * 0.08),
            transition_start,
            image_height - 1,
        )
    )
    parsed_chin_y = landmark_chin_y
    transition_rows = 0
    for row in range(transition_start, transition_end + 1):
        row_face = np.mean(face_probability[row, band_left:band_right])
        row_body = np.mean(body_probability[row, band_left:band_right])
        row_alpha = np.mean(original_alpha[row, band_left:band_right])
        if row_face < 0.15 and row_body > 0.60 and row_alpha > 0.50:
            transition_rows += 1
            if transition_rows >= 2:
                parsed_chin_y = float(row - transition_rows + 1)
                break
        else:
            transition_rows = 0

    chin_y = float(
        np.clip(
            max(landmark_chin_y, min(parsed_chin_y, landmark_chin_y + face_height * 0.04)),
            face_y + face_height * 0.78,
            face_bottom + face_height * 0.04,
        )
    )

    scan_start = int(np.clip(round(chin_y), 0, image_height - 1))
    scan_end = int(
        np.clip(round(chin_y + face_height * 0.60), scan_start, image_height - 1)
    )
    skin_bottom = scan_start
    missing_rows = 0
    minimum_rows = max(2, round(face_height * 0.008))
    for row in range(scan_start, scan_end + 1):
        row_skin = skin_probability[row, band_left:band_right]
        row_clothes = parsing_probabilities[row, band_left:band_right, 4]
        row_alpha = original_alpha[row, band_left:band_right]
        if np.mean((row_skin > 0.45) & (row_skin > row_clothes) & (row_alpha > 0.50)) >= 0.55:
            skin_bottom = row
            missing_rows = 0
        else:
            missing_rows += 1
            if missing_rows >= minimum_rows:
                break

    neck_length = 0
    continuous_rows = 0
    for row in range(scan_start, skin_bottom + 1):
        row_body = body_probability[row, band_left:band_right]
        row_clothes = parsing_probabilities[row, band_left:band_right, 4]
        row_alpha = original_alpha[row, band_left:band_right]
        if np.mean((row_body > 0.45) & (row_body > row_clothes) & (row_alpha > 0.50)) >= 0.55:
            continuous_rows += 1
            neck_length = max(neck_length, continuous_rows)
        else:
            continuous_rows = 0

    skin_outline = np.uint8((skin_probability > 0.45) & (original_alpha > 0.50))
    radius = max(1, round(face_width * 0.015))
    skin_outline = cv2.morphologyEx(
        skin_outline,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)),
    )
    neck_spans = []
    for row in range(
        max(0, round(chin_y - face_height * 0.28)),
        min(image_height, round(chin_y - face_height * 0.06)),
    ):
        span = _find_center_span(skin_outline[row], round(center_x), round(face_width * 0.12))
        if span is not None and span[1] - span[0] > face_width * 0.35:
            neck_spans.append((span[1] - span[0], row, span[0], span[1]))
    neck_left = None
    neck_right = None
    if neck_spans:
        _, _, neck_left, neck_right = min(neck_spans)
        neck_left = float(neck_left)
        neck_right = float(neck_right)

    return {
        "chin_y": chin_y,
        "skin_bottom": float(skin_bottom),
        "neck_length": float(neck_length),
        "face_height": face_height,
        "retained_probability": (
            np.sum(parsing_probabilities[:, :, [1, 2, 3, 5]], axis=2)
        ),
        "neck_left": neck_left,
        "neck_right": neck_right,
        "skin_probability": skin_probability,
        "face_probability": face_probability,
        "clothes_probability": parsing_probabilities[:, :, 4],
        "hair_probability": parsing_probabilities[:, :, 1],
    }

def _bounded_opening_span(alpha_row, center_x, previous_span):
    """只追踪两侧均有真实衣料包围的中央透明区"""
    if alpha_row[center_x] > 32:
        if previous_span is None:
            return None
        candidates = np.flatnonzero(alpha_row[previous_span[0]:previous_span[1] + 1] <= 32)
        if candidates.size == 0:
            return None
        candidates += previous_span[0]
        center_x = int(candidates[np.argmin(np.abs(candidates - center_x))])
    left = center_x
    right = center_x
    while left > 0 and alpha_row[left - 1] <= 32:
        left -= 1
    while right + 1 < len(alpha_row) and alpha_row[right + 1] <= 32:
        right += 1
    if left == 0 or right == len(alpha_row) - 1:
        return None
    return left, right

def _sample_mask(mask, count):
    """按规则网格采样区域内部，返回素材像素坐标x和y"""
    area = int(np.count_nonzero(mask))
    step = max(1, int(np.sqrt(area / count)))
    rows, columns = np.mgrid[0:mask.shape[0]:step, 0:mask.shape[1]:step]
    selected = mask[rows, columns] > 0
    points = np.column_stack((columns[selected], rows[selected])).astype(np.float32)
    if len(points) > count:
        points = points[np.linspace(0, len(points) - 1, count).astype(np.int32)]
    return points

def _sample_boundary(mask, count):
    """均匀采样真实区域边界"""
    contours, _ = cv2.findContours(np.uint8(mask), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return np.empty((0, 2), dtype=np.float32)
    points = np.concatenate([contour[:, 0] for contour in contours]).astype(np.float32)
    if len(points) > count:
        points = points[np.linspace(0, len(points) - 1, count).astype(np.int32)]
    return points

def _analyze_clothes(clothes):
    """抽取领座以下的完整中央开口及衣料碰撞样本"""
    height, width = clothes.shape[:2]
    alpha = clothes[:, :, 3]
    _, opaque_columns = np.where(alpha > 32)
    if opaque_columns.size == 0:
        raise ValueError("服装图片无效")
    center_x = int(round((opaque_columns.min() + opaque_columns.max()) / 2.0))
    opening_mask = np.zeros((height, width), dtype=np.uint8)
    spans = []
    previous = None
    closed_rows = 0
    for row in range(height):
        span = _bounded_opening_span(alpha[row], center_x, previous)
        if span is None:
            if spans:
                closed_rows += 1
                if closed_rows >= 2:
                    break
            continue
        if not spans and not width * 0.08 <= span[1] - span[0] + 1 <= width * 0.45:
            continue
        previous = span
        closed_rows = 0
        spans.append((row, span[0], span[1]))
        opening_mask[row, span[0]:span[1] + 1] = 1
    if len(spans) < 3:
        raise ValueError("服装领口识别失败")
    top_spans = spans[:min(4, len(spans))]
    opaque_mask = np.uint8(alpha > 200)
    upper_mask = opaque_mask.copy()
    upper_mask[min(height, max(spans[-1][0] + 1, round(height * 0.45))):] = 0
    return {
        "opening_mask": opening_mask,
        "opening_points": _sample_mask(opening_mask, 384),
        "opening_boundary_points": _sample_boundary(opening_mask, 256),
        "garment_points": _sample_mask(opaque_mask, 256),
        "garment_boundary_points": _sample_boundary(upper_mask, 256),
        "opaque_mask": opaque_mask,
        "center_x": float(center_x),
        "opening_left": float(np.median([span[1] for span in top_spans])),
        "opening_right": float(np.median([span[2] for span in top_spans])),
        "opening_top": float(spans[0][0]),
        "opening_bottom": float(spans[-1][0] + 1),
        "spans": np.asarray(spans, dtype=np.int32),
    }

def _render_garment(clothes, input_shape, scale, left, top, protect_y):
    """领部按比例放置，保护线以下以C1连续方式纵向延展衣身"""
    height, width = input_shape[:2]
    source_height, _ = clothes.shape[:2]
    if scale <= 0 or not 0 <= protect_y < source_height - 1:
        raise ValueError("服装放置参数无效")
    extra = max(0.0, height + 2.0 - (top + scale * (source_height - 1)))
    remaining = source_height - 1.0 - protect_y
    rows = np.arange(height, dtype=np.float64)
    relative = rows - top - scale * protect_y
    source_rows = (rows - top) / scale
    if extra > 0:
        coefficient = extra / (remaining * remaining)
        below = relative > 0
        # 用有理化正根计算纵向映射，保持小延展量下的数值稳定性
        source_rows[below] = protect_y + (
            2.0 * relative[below]
            / (scale + np.sqrt(scale * scale + 4.0 * coefficient * relative[below]))
        )
    source_columns = (np.arange(width, dtype=np.float32) - left) / scale
    map_x = np.broadcast_to(source_columns[None, :], (height, width)).copy()
    map_y = np.broadcast_to(source_rows.astype(np.float32)[:, None], (height, width)).copy()
    normalized = clothes.astype(np.float32) / 255.0
    normalized[:, :, :3] *= normalized[:, :, 3:4]
    remapped = cv2.remap(
        normalized, map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )
    remapped[:, :, :3] = np.divide(
        remapped[:, :, :3], remapped[:, :, 3:4],
        out=np.zeros_like(remapped[:, :, :3]),
        where=remapped[:, :, 3:4] > 0,
    )
    return np.uint8(np.clip(np.rint(remapped * 255.0), 0, 255))

def _match_clothes_detail(
    clothes_layer: np.ndarray,
    input_image: np.ndarray,
    face: np.ndarray,
) -> np.ndarray:
    """按柔焦人像的清晰度减弱服装细节"""
    face_x, face_y, face_width, face_height = [float(value) for value in face[:4]]
    face_image = input_image[
        max(0, int(face_y)):min(input_image.shape[0], int(face_y + face_height)),
        max(0, int(face_x)):min(input_image.shape[1], int(face_x + face_width)),
        :3,
    ]
    gray = cv2.cvtColor(face_image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray = cv2.resize(
        gray,
        (128, round(128 * gray.shape[0] / gray.shape[1])),
        interpolation=cv2.INTER_AREA if gray.shape[1] > 128 else cv2.INTER_CUBIC,
    )
    gray = cv2.GaussianBlur(gray, (0, 0), 0.8)
    blurred_gray = cv2.GaussianBlur(gray, (0, 0), 1.2)
    gradients = [
        cv2.magnitude(
            cv2.Scharr(image, cv2.CV_32F, 1, 0),
            cv2.Scharr(image, cv2.CV_32F, 0, 1),
        )
        for image in (gray, blurred_gray)
    ]
    interior = np.zeros(gray.shape, dtype=bool)
    interior[int(gray.shape[0] * 0.12):int(gray.shape[0] * 0.90), 20:108] = True
    strong_edges = interior & (gradients[0] >= np.percentile(gradients[0][interior], 80))
    edge_strength = float(gradients[0][strong_edges].sum())
    if edge_strength <= strong_edges.sum():
        return clothes_layer
    detail = 1.0 - float(gradients[1][strong_edges].sum()) / edge_strength
    if detail >= 0.16:
        return clothes_layer
    sigma = min(2.0, np.sqrt(4.0 * (0.16 / max(detail, 0.01) - 1.0)))
    sigma *= face_width / 128.0
    if sigma < 0.25:
        return clothes_layer
    normalized = clothes_layer.astype(np.float32) / 255.0
    normalized[:, :, :3] *= normalized[:, :, 3:4]
    blurred = cv2.GaussianBlur(normalized, (0, 0), sigma)
    blurred[:, :, :3] = np.divide(
        blurred[:, :, :3],
        blurred[:, :, 3:4],
        out=np.zeros_like(blurred[:, :, :3]),
        where=blurred[:, :, 3:4] > 0,
    )
    return np.uint8(np.clip(blurred * 255.0, 0, 255))

def _create_head_layer(
    input_image: np.ndarray,
    face: np.ndarray,
    parsing_probabilities: np.ndarray,
    chin_y: float,
) -> np.ndarray:
    """提取原始头部、头发和饰品供前后景分层"""
    image_height = input_image.shape[0]
    _, _, _, face_height = [float(value) for value in face[:4]]
    rows = np.arange(image_height, dtype=np.float32)
    face_fade_start = chin_y - face_height * 0.01
    face_fade_end = chin_y + face_height * 0.025
    face_keep = 1.0 - np.clip(
        (rows - face_fade_start) / max(face_fade_end - face_fade_start, 1.0),
        0.0,
        1.0,
    )
    face_keep = face_keep * face_keep * (3.0 - 2.0 * face_keep)
    head_probability = (
        parsing_probabilities[:, :, 1]
        + parsing_probabilities[:, :, 3] * face_keep[:, None]
        + parsing_probabilities[:, :, 5]
    )
    head_support = head_probability > 0.50
    lower_head_share = head_probability / (
        head_probability + parsing_probabilities[:, :, 2] + parsing_probabilities[:, :, 4]
    )
    # 按衣物类别概率清理颈肩区域
    clothes_rejection = np.clip(
        (parsing_probabilities[:, :, 4] - head_probability) / 0.20,
        0.0,
        1.0,
    )
    clothes_rejection[rows < chin_y - face_height * 0.10] = 0.0
    # 在人物内部类别中归一化头部概率
    head_probability /= np.sum(parsing_probabilities[:, :, 1:], axis=2)
    mask = np.clip((head_probability - 0.08) / 0.72, 0.0, 1.0)
    mask *= 1.0 - clothes_rejection
    # 下巴以下按人物内部类别保留头发
    mask[rows >= chin_y] *= np.clip((lower_head_share[rows >= chin_y] - 0.25) / 0.25, 0.0, 1.0)
    mask = cv2.GaussianBlur(mask, (0, 0), 0.6)

    head_layer = input_image.copy()
    original_alpha = input_image[:, :, 3].astype(np.float32) / 255.0
    head_layer[:, :, 3] = np.uint8(np.clip(original_alpha * mask * 255.0, 0, 255))
    # 移除缺少头部类别支撑的独立碎片
    _, components = cv2.connectedComponents(np.uint8(head_layer[:, :, 3] > 0))
    head_components = np.unique(components[head_support & (head_layer[:, :, 3] > 0)])
    head_layer[:, :, 3][~np.isin(components, head_components)] = 0
    return head_layer

def _create_clothes_layer(
    input_image: np.ndarray,
    clothes_image: np.ndarray,
    clothes_geometry: dict,
    face: np.ndarray,
    neck_geometry: dict,
) -> tuple[np.ndarray, dict]:
    """在可见皮肤范围内搜索完整领口的放置位置"""
    height, width = input_image.shape[:2]
    face_width, face_height = float(face[2]), float(face[3])
    chin_y = neck_geometry["chin_y"]
    neck_width = neck_geometry["neck_right"] - neck_geometry["neck_left"]
    center_x = (neck_geometry["neck_right"] + neck_geometry["neck_left"]) / 2.0
    opening_width = clothes_geometry["opening_right"] - clothes_geometry["opening_left"]
    opening_center = (clothes_geometry["opening_right"] + clothes_geometry["opening_left"]) / 2.0
    opening_depth = clothes_geometry["opening_bottom"] - clothes_geometry["opening_top"]
    support = np.uint8(neck_geometry["opening_support"] > 0)
    outside = cv2.distanceTransform(1 - support, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    points = np.concatenate((clothes_geometry["opening_points"], clothes_geometry["opening_boundary_points"]))
    scales = neck_width / opening_width * np.linspace(0.78, 1.30, 27)
    centers = center_x + np.linspace(-0.08, 0.08, 17) * face_width
    tops = chin_y + np.linspace(-0.16, 0.08, 25) * face_height
    scale, center, opening_top = np.meshgrid(scales, centers, tops, indexing="ij")
    scale, center, opening_top = scale.ravel(), center.ravel(), opening_top.ravel()
    left = center - opening_center * scale
    top = opening_top - clothes_geometry["opening_top"] * scale
    bottom = top + clothes_geometry["opening_bottom"] * scale
    x = np.rint(left[:, None] + scale[:, None] * points[None, :, 0]).astype(np.int32)
    y = np.rint(top[:, None] + scale[:, None] * points[None, :, 1]).astype(np.int32)
    distances = outside[np.clip(y, 0, height - 1), np.clip(x, 0, width - 1)]
    distances[(x < 0) | (x >= width) | (y < 0) | (y >= height)] = max(height, width)
    worst_gap = distances.max(axis=1)
    mean_gap = distances.mean(axis=1)
    collar_depth = opening_depth * scale
    target_bottom = chin_y + np.maximum(face_height * 0.18, collar_depth - face_height * 0.04)
    target_bottom = np.minimum(target_bottom, neck_geometry["skin_bottom"] - face_height * 0.04)
    preferred_scale = neck_width / opening_width
    score = (
        3.0 * ((scale / preferred_scale - 1.0) ** 2)
        + ((bottom - target_bottom) / (face_height * 0.12)) ** 2
        + ((center - center_x) / (face_width * 0.12)) ** 2
        + 6.0 * (mean_gap / max(1.0, face_height * 0.01)) ** 2
    )
    # 按实际皮肤边界和前景头发约束领座可见端
    skin_support = np.uint8(neck_geometry["skin_mask"] > 0.5)
    left_boundary = np.zeros(height, dtype=np.float32)
    right_boundary = np.zeros(height, dtype=np.float32)
    valid_rows = np.zeros(height, dtype=bool)
    for row in range(height):
        span = _find_center_span(skin_support[row], round(center_x), 0)
        if span is not None:
            left_boundary[row], right_boundary[row] = span
            valid_rows[row] = True
    seam_x = left[:, None] + scale[:, None] * np.array([
        clothes_geometry["opening_left"], clothes_geometry["opening_right"],
    ])[None, :]
    seam_y = np.rint(opening_top).astype(np.int32)
    seam_inside = np.all((seam_x >= 0) & (seam_x < width), axis=1) & (seam_y >= 0) & (seam_y < height)
    seam_columns = np.clip(np.rint(seam_x).astype(np.int32), 0, width - 1)
    seam_rows = np.clip(seam_y, 0, height - 1)
    seam_hair = (
        (neck_geometry["hair_probability"][seam_rows[:, None], seam_columns] > 0.5)
        & (neck_geometry["head_alpha"][seam_rows[:, None], seam_columns] > 0.90)
    )
    seam_gap = np.abs(seam_x - np.column_stack((left_boundary[seam_rows], right_boundary[seam_rows])))
    seam_gap[seam_hair] = 0.0
    attached = seam_inside & valid_rows[seam_rows] & np.all(seam_gap <= max(2.0, face_width * 0.015), axis=1)
    # 校验中央脸部与衣料的重叠范围
    rows, columns = np.ogrid[:height, :width]
    face_core = (
        (neck_geometry["face_probability"] > 0.75)
        & (rows < chin_y - face_height * 0.08)
        & (columns > float(face[0]) + face_width * 0.22)
        & (columns < float(face[0]) + face_width * 0.78)
    )
    garment_points = np.concatenate((clothes_geometry["garment_points"], clothes_geometry["garment_boundary_points"]))
    garment_x = np.rint(left[:, None] + scale[:, None] * garment_points[None, :, 0]).astype(np.int32)
    garment_y = np.rint(top[:, None] + scale[:, None] * garment_points[None, :, 1]).astype(np.int32)
    garment_in_frame = (garment_x >= 0) & (garment_x < width) & (garment_y >= 0) & (garment_y < height)
    collision = np.any(
        garment_in_frame & face_core[np.clip(garment_y, 0, height - 1), np.clip(garment_x, 0, width - 1)],
        axis=1,
    )
    feasible = (
        attached & ~collision
        & (worst_gap <= max(1.0, face_width * 0.006))
        & (bottom >= chin_y + face_height * 0.12)
        & (bottom <= neck_geometry["skin_bottom"] - face_height * 0.015)
    )
    score[~feasible] = np.inf
    chosen = int(np.argmin(score))
    if not np.isfinite(score[chosen]):
        raise ValueError("服装领口超过可见皮肤范围，请选择其它服装")
    source_height, source_width = clothes_image.shape[:2]
    protect_y = max(source_height * 0.66, clothes_geometry["opening_bottom"] + source_height * 0.10)
    clothes_layer = _render_garment(
        clothes_image, input_image.shape, float(scale[chosen]), float(left[chosen]),
        float(top[chosen]), min(protect_y, source_height - 2.0),
    )
    if np.any(face_core & (clothes_layer[:, :, 3] > 200)):
        raise ValueError("服装结构与当前人物比例不匹配")
    if source_width >= MIN_CLOTHES_DETAIL_WIDTH:
        clothes_layer = _match_clothes_detail(clothes_layer, input_image, face)
    transform = np.float32([[scale[chosen], 0.0, left[chosen]], [0.0, scale[chosen], top[chosen]]])
    opening_mask = cv2.warpAffine(
        clothes_geometry["opening_mask"].astype(np.float32), transform, (width, height),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
    )
    neck_geometry["opening_mask"] = opening_mask
    neck_geometry["opening_top_y"] = float(opening_top[chosen])
    neck_geometry["opening_left_x"] = float(left[chosen] + clothes_geometry["opening_left"] * scale[chosen])
    neck_geometry["opening_right_x"] = float(left[chosen] + clothes_geometry["opening_right"] * scale[chosen])
    return clothes_layer, {
        "left": float(left[chosen]),
        "top": float(top[chosen]),
        "protectY": float(min(protect_y, source_height - 2.0)),
        "templateWidth": int(source_width),
        "templateHeight": int(source_height),
        "body_extension": max(0.0, height + 2.0 - (top[chosen] + scale[chosen] * (source_height - 1))),
        "protected_source_y": float(protect_y),
        "opening_mask": opening_mask,
        "opening_left_x": neck_geometry["opening_left_x"],
        "opening_right_x": neck_geometry["opening_right_x"],
        "opening_top_y": float(opening_top[chosen]),
        "collar_y": float(bottom[chosen]),
        "scale": float(scale[chosen]),
        "worst_gap": float(worst_gap[chosen]),
        "seam_gap": float(seam_gap[chosen].max()),
        "score": float(score[chosen]),
        "feasible_candidates": int(feasible.sum()),
    }

def _create_neck_mask(input_image: np.ndarray, neck_geometry: dict) -> np.ndarray:
    """按类别概率和中心连通截面建立搜索与合成共用的颈部保留域"""
    height = input_image.shape[0]
    skin = neck_geometry["skin_probability"]
    cloth = neck_geometry["clothes_probability"]
    original = input_image[:, :, 3].astype(np.float32) / 255.0
    region = np.uint8((skin > cloth) & (skin > neck_geometry["hair_probability"]) & (original > 0.5))
    _, labels = cv2.connectedComponents(region)
    center = round((neck_geometry["neck_left"] + neck_geometry["neck_right"]) / 2.0)
    seed_row = int(np.clip(round(neck_geometry["chin_y"]), 0, height - 1))
    seed = labels[seed_row, center]
    region = np.float32((labels == seed) & (seed != 0))
    # 只保留穿过颈部中心的横截面
    for row in range(max(0, round(neck_geometry["chin_y"] - neck_geometry["face_height"] * 0.25)), height):
        span = _find_center_span(region[row] > 0, center, 0)
        if span is None:
            region[row] = 0.0
        else:
            region[row, :span[0]] = 0.0
            region[row, span[1] + 1:] = 0.0
    region = cv2.GaussianBlur(region, (0, 0), 0.55)
    return region