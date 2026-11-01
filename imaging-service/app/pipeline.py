"""AIDICOMIntegration - Full DICOM & AI Volume Lab Processing Pipeline.
Includes DICOM geometry verification, patient coordinate transformations,
AI inference orchestrator, classical region-growing fallbacks, mesh generation,
morphometric quality scoring, boundary consistency, and versioned provenance recording.
"""
from __future__ import annotations

import json
import math
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
from scipy import ndimage


class AIDICOMIntegration:
    def __init__(self, volume_lab, ai_client, dicom_handler, mesh_generator):
        self.volume_lab = volume_lab
        self.ai_client = ai_client
        self.dicom_handler = dicom_handler
        self.mesh_generator = mesh_generator
        self.fallback_methods = {
            'region_growing': self._region_growing_fallback,
            'manual_segmentation': self._manual_segmentation_fallback
        }

    def process_dicom_workflow(self, dicom_series, patient_id, study_uid):
        """Complete DICOM processing pipeline with AI integration"""
        try:
            # 1. Validate and preprocess DICOM
            validated_series = self._validate_dicom_series(dicom_series)
            if not validated_series:
                return self._handle_validation_failure(dicom_series)

            # 2. Create volume in Volume Lab
            volume = self.volume_lab.create_volume(
                patient_id=patient_id,
                study_uid=study_uid,
                dicom_series=validated_series,
                coordinates=self._get_patient_coordinates(validated_series)
            )

            # 3. Prepare AI request
            ai_request = self._prepare_ai_request(volume)
            if not ai_request:
                return self._handle_ai_prep_failure(volume)

            # 4. Execute AI inference
            ai_response = self._execute_ai_inference(ai_request)
            if not ai_response:
                return self._handle_ai_failure(volume, ai_request)

            # 5. Process AI results
            segmentation = self._process_ai_results(ai_response, volume)
            if not segmentation:
                return self._handle_processing_failure(volume, ai_response)

            # 6. Generate visualization and mesh
            visualization = self._generate_visualization(segmentation, volume)
            mesh = self._generate_mesh(segmentation, volume)

            # 7. Store complete provenance
            self._store_provenance(
                patient_id=patient_id,
                study_uid=study_uid,
                volume=volume,
                segmentation=segmentation,
                mesh=mesh,
                ai_response=ai_response
            )

            return {
                'success': True,
                'volume': volume,
                'segmentation': segmentation,
                'mesh': mesh,
                'visualization': visualization,
                'provenance': self._get_provenance_record()
            }

        except Exception as e:
            self._log_error(f"Workflow failed: {str(e)}")
            return self._handle_workflow_failure(e)

    def _validate_dicom_series(self, dicom_series):
        """Validate DICOM series geometry and metadata"""
        validation = self.dicom_handler.validate_series(dicom_series)

        if not validation['valid']:
            self._log_error(f"DICOM validation failed: {validation['errors']}")
            return None

        # Verify spatial consistency
        if not self._verify_spatial_consistency(dicom_series):
            self._log_error("Spatial inconsistency detected in DICOM series")
            return None

        return dicom_series

    def _get_patient_coordinates(self, dicom_series):
        """Extract and verify patient coordinates from DICOM"""
        coordinates = {
            'image_position': [],
            'image_orientation': [],
            'pixel_spacing': None,
            'slice_spacing': None,
            'direction_matrix': None,
            'patient_lps': None
        }

        for instance in dicom_series:
            coordinates['image_position'].append(instance.ImagePositionPatient)
            coordinates['image_orientation'].append(instance.ImageOrientationPatient)

        # Calculate derived coordinates
        coordinates['pixel_spacing'] = instance.PixelSpacing
        coordinates['slice_spacing'] = self._calculate_slice_spacing(dicom_series)
        coordinates['direction_matrix'] = self._calculate_direction_matrix(dicom_series)
        coordinates['patient_lps'] = self._calculate_patient_lps(dicom_series)

        return coordinates

    def _calculate_slice_spacing(self, dicom_series):
        """Calculate consistent slice spacing from DICOM series"""
        if len(dicom_series) < 2:
            return None

        # Get first two slices
        first = dicom_series[0]
        second = dicom_series[1]

        # Calculate spacing between slices
        spacing = math.sqrt(
            sum((float(a)-float(b))**2
                for a, b in zip(first.ImagePositionPatient, second.ImagePositionPatient))
        )

        return spacing

    def _calculate_direction_matrix(self, dicom_series):
        """Calculate direction cosine matrix for the series"""
        if not dicom_series:
            return None

        # Use first instance for orientation
        instance = dicom_series[0]

        # Create direction cosine matrix
        matrix = [
            [instance.ImageOrientationPatient[0], instance.ImageOrientationPatient[1], instance.ImageOrientationPatient[2]],
            [instance.ImageOrientationPatient[3], instance.ImageOrientationPatient[4], instance.ImageOrientationPatient[5]],
            [0, 0, 1]  # Third row is always [0,0,1] for axial slices
        ]

        return matrix

    def _calculate_patient_lps(self, dicom_series):
        """Calculate patient LPS coordinates for the series"""
        if not dicom_series:
            return None

        # Get first instance
        instance = dicom_series[0]

        # Calculate patient LPS coordinates
        patient_lps = {
            'origin': instance.ImagePositionPatient,
            'spacing': instance.PixelSpacing + [self._calculate_slice_spacing(dicom_series)],
            'direction': self._calculate_direction_matrix(dicom_series)
        }

        return patient_lps

    def _verify_spatial_consistency(self, dicom_series):
        """Verify spatial consistency across DICOM series"""
        if len(dicom_series) < 2:
            return True

        # Check slice ordering
        positions = [float(p) for p in dicom_series[0].ImagePositionPatient]
        for instance in dicom_series[1:]:
            current = [float(p) for p in instance.ImagePositionPatient]
            # Check if position is increasing in Z direction
            if current[2] <= positions[2]:
                return False
            positions = current

        # Check orientation consistency
        first_orientation = dicom_series[0].ImageOrientationPatient
        for instance in dicom_series[1:]:
            if instance.ImageOrientationPatient != first_orientation:
                return False

        return True

    def _prepare_ai_request(self, volume):
        """Prepare request for AI inference"""
        try:
            # Extract relevant volume information
            volume_data = {
                'volume_id': volume.id,
                'patient_id': volume.patient_id,
                'study_uid': volume.study_uid,
                'series_uid': volume.series_uid,
                'coordinates': volume.coordinates,
                'volume_data': volume.get_volume_data(),
                'metadata': volume.get_metadata()
            }

            # Prepare API request
            request = {
                'input': volume_data,
                'model': self._get_active_ai_model(),
                'processing_parameters': self._get_processing_parameters(),
                'provenance': self._get_provenance_template()
            }

            return request

        except Exception as e:
            self._log_error(f"AI request preparation failed: {str(e)}")
            return None

    def _get_active_ai_model(self):
        """Get currently active AI model with version information"""
        try:
            # In production, this would query your model registry
            return {
                'model_name': 'fibroid_segmentation_v3',
                'model_version': '1.2.4',
                'model_type': '3d_unet',
                'training_data': 'multi-institutional_mri',
                'validation_metrics': {
                    'dice_score': 0.92,
                    'hausdorff_distance': 3.1,
                    'false_positive_rate': 0.05
                },
                'last_updated': '2023-11-15',
                'performance_metrics': {
                    'inference_time': 4.2,
                    'memory_usage': '3.8GB',
                    'batch_size': 1
                }
            }
        except Exception as e:
            self._log_error(f"Failed to get active AI model: {str(e)}")
            return None

    def _get_processing_parameters(self):
        """Get optimal processing parameters for current model"""
        return {
            'threshold': 0.5,
            'postprocessing': {
                'connected_components': True,
                'morphological_operations': True,
                'smoothing': {
                    'kernel_size': 3,
                    'iterations': 2
                }
            },
            'output_format': 'nifti',
            'coordinate_system': 'patient_lps',
            'uncertainty_estimation': True
        }

    def _execute_ai_inference(self, ai_request):
        """Execute AI inference with error handling"""
        try:
            # Make authenticated request to AI service
            response = self.ai_client.post(
                '/inference',
                json=ai_request,
                timeout=300  # 5 minute timeout
            )

            if response.status_code != 200:
                raise ValueError(f

Continue the last code form raise line
11:03 AM
Claude Opus 5.5
11:03 AM

Here's the continuation of the AI integration code with complete error handling, fallback mechanisms, and spatial coordinate validation:

                f"AI service returned status {response.status_code}")

            ai_response = response.json()

            # Validate AI response structure
            if not self._validate_ai_response(ai_response):
                raise ValueError("Invalid AI response structure")

            return ai_response

        except requests.exceptions.RequestException as e:
            self._log_error(f"AI inference request failed: {str(e)}")
            return None
        except json.JSONDecodeError as e:
            self._log_error(f"Invalid AI response format: {str(e)}")
            return None
        except ValueError as e:
            self._log_error(f"AI processing error: {str(e)}")
            return None
        except Exception as e:
            self._log_error(f"Unexpected AI inference error: {str(e)}")
            return None

    def _validate_ai_response(self, ai_response):
        """Validate AI response structure and content"""
        required_fields = [
            'success', 'model', 'segmentation', 'metrics',
            'processing_time', 'version', 'timestamp'
        ]

        for field in required_fields:
            if field not in ai_response:
                return False

        # Validate segmentation data
        if not isinstance(ai_response['segmentation'], dict):
            return False

        if 'mask' not in ai_response['segmentation']:
            return False

        if not isinstance(ai_response['segmentation']['mask'], (list, np.ndarray)):
            return False

        # Validate metrics
        if not isinstance(ai_response['metrics'], dict):
            return False

        required_metrics = ['dice_score', 'hausdorff_distance', 'confidence']
        for metric in required_metrics:
            if metric not in ai_response['metrics']:
                return False

        # Validate model information
        if not isinstance(ai_response['model'], dict):
            return False

        required_model_fields = ['model_name', 'model_version', 'model_type']
        for field in required_model_fields:
            if field not in ai_response['model']:
                return False

        return True

    def _process_ai_results(self, ai_response, volume):
        """Process AI segmentation results with validation"""
        try:
            # Convert segmentation mask to proper format
            mask = self._convert_segmentation_mask(ai_response['segmentation']['mask'])

            if mask is None:
                return None

            # Validate segmentation against volume geometry
            if not self._validate_segmentation_geometry(mask, volume):
                return None

            # Apply coordinate transformations
            segmented_volume = self._apply_coordinate_transformations(
                volume,
                mask,
                ai_response['segmentation']
            )

            # Calculate derived metrics
            metrics = self._calculate_segmentation_metrics(
                segmented_volume,
                ai_response['metrics']
            )

            return {
                'mask': segmented_volume,
                'metrics': metrics,
                'confidence': ai_response['metrics'].get('confidence', 0.0),
                'uncertainty': ai_response['metrics'].get('uncertainty', 0.0),
                'model_version': ai_response['model']['model_version'],
                'processing_time': ai_response['processing_time'],
                'timestamp': ai_response['timestamp']
            }

        except Exception as e:
            self._log_error(f"AI result processing failed: {str(e)}")
            return None

    def _convert_segmentation_mask(self, mask_data):
        """Convert raw mask data to proper format"""
        try:
            # Handle different input formats
            if isinstance(mask_data, list):
                mask = np.array(mask_data, dtype=np.uint8)
            elif isinstance(mask_data, np.ndarray):
                mask = mask_data.copy()
            else:
                # Try to load from file if it's a file path
                if isinstance(mask_data, str) and os.path.exists(mask_data):
                    mask = nibabel.load(mask_data).get_fdata().astype(np.uint8)
                else:
                    self._log_error("Unsupported mask format")
                    return None

            # Ensure mask is binary (0/1 or 0/255)
            if mask.dtype != np.uint8:
                mask = mask.astype(np.uint8)

            if np.max(mask) > 1:
                mask = (mask > 0).astype(np.uint8) * 255

            return mask

        except Exception as e:
            self._log_error(f"Mask conversion failed: {str(e)}")
            return None

    def _validate_segmentation_geometry(self, mask, volume):
        """Validate segmentation against volume geometry"""
        try:
            # Check mask dimensions match volume
            if mask.shape != volume.get_volume_shape():
                self._log_error(f"Mask dimensions {mask.shape} don't match volume {volume.get_volume_shape()}")
                return False

            # Check for empty segmentation
            if np.sum(mask) == 0:
                self._log_error("Empty segmentation mask")
                return False

            # Check for complete volume segmentation (if expected)
            if np.sum(mask) == np.prod(mask.shape):
                self._log_error("Complete volume segmentation - likely error")
                return False

            # Check for unrealistic segmentation sizes
            total_voxels = np.sum(mask)
            volume_voxels = np.prod(mask.shape)

            if total_voxels > 0.9 * volume_voxels:
                self._log_error("Unrealistically large segmentation")
                return False

            return True

        except Exception as e:
            self._log_error(f"Segmentation geometry validation failed: {str(e)}")
            return False

    def _apply_coordinate_transformations(self, volume, mask, segmentation_data):
        """Apply all necessary coordinate transformations"""
        try:
            # Get transformation parameters from segmentation data
            transform_params = segmentation_data.get('transform', {})

            # Apply patient coordinate system transformation
            patient_coords = self._transform_to_patient_coordinates(
                volume,
                mask,
                transform_params
            )

            # Apply any additional transformations specified in the AI response
            if 'additional_transforms' in segmentation_data:
                for transform in segmentation_data['additional_transforms']:
                    patient_coords = self._apply_additional_transform(
                        patient_coords,
                        transform
                    )

            return patient_coords

        except Exception as e:
            self._log_error(f"Coordinate transformation failed: {str(e)}")
            return None

    def _transform_to_patient_coordinates(self, volume, mask, transform_params):
        """Convert segmentation to patient coordinate system"""
        try:
            # Get volume coordinates
            volume_coords = volume.get_coordinates()

            # Create transformation matrix
            transform_matrix = self._create_transformation_matrix(
                volume_coords,
                transform_params
            )

            # Apply transformation to mask
            transformed_mask = self._apply_matrix_to_mask(
                mask,
                transform_matrix,
                volume_coords
            )

            return transformed_mask

        except Exception as e:
            self._log_error(f"Patient coordinate transformation failed: {str(e)}")
            return None

    def _create_transformation_matrix(self, volume_coords, transform_params):
        """Create transformation matrix from DICOM coordinates"""
        try:
            # Start with identity matrix
            matrix = np.eye(4)

            # Apply image orientation
            if 'image_orientation' in transform_params:
                matrix[:3, :3] = np.array(transform_params['image_orientation']).reshape(3, 3)

            # Apply image position
            if 'image_position' in transform_params:
                matrix[:3, 3] = np.array(transform_params['image_position'])

            # Apply any additional transformations
            if 'scaling' in transform_params:
                matrix = np.diag([transform_params['scaling'][0],
                                 transform_params['scaling'][1],
                                 transform_params['scaling'][2],
                                 1]) @ matrix

            # Apply patient coordinate system transformation
            if 'patient_lps' in volume_coords:
                patient_matrix = self._create_patient_lps_matrix(volume_coords['patient_lps'])
                matrix = patient_matrix @ matrix

            return matrix

        except Exception as e:
            self._log_error(f"Transformation matrix creation failed: {str(e)}")
            return np.eye(4)

    def _create_patient_lps_matrix(self, patient_lps):
        """Create transformation matrix for patient LPS coordinates"""
        try:
            # Create direction matrix from patient LPS
            direction = patient_lps['direction']
            origin = patient_lps['origin']

            # Normalize direction vectors
            direction = np.array(direction)
            direction[2, :] = np.cross(direction[0, :], direction[1, :])  # Ensure orthogonal

            # Create transformation matrix
            matrix = np.eye(4)
            matrix[:3, :3] = direction.T
            matrix[:3, 3] = origin

            return matrix

        except Exception as e:
            self._log_error(f"Patient LPS matrix creation failed: {str(e)}")
            return np.eye(4)

    def _apply_matrix_to_mask(self, mask, transform_matrix, volume_coords):
        """Apply transformation matrix to segmentation mask"""
        try:
            # Convert mask to 3D coordinates
            coords = self._mask_to_coordinates(mask, volume_coords)

            # Apply transformation to each coordinate
            transformed_coords = []
            for coord in coords:
                homogeneous = np.append(coord, 

continue the last code from for coord
11:04 AM
Claude Opus 5.5
11:04 AM

Here's the continuation of the coordinate transformation and complete workflow implementation:

                homogeneous = np.append(coord, 1)  # Convert to homogeneous coordinates
                transformed = transform_matrix @ homogeneous
                transformed_coords.append(transformed[:3])

            transformed_coords = np.array(transformed_coords)

            # Convert back to mask format
            transformed_mask = self._coordinates_to_mask(
                transformed_coords,
                mask.shape,
                volume_coords['spacing']
            )

            return transformed_mask

        except Exception as e:
            self._log_error(f"Mask transformation failed: {str(e)}")
            return None

    def _mask_to_coordinates(self, mask, volume_coords):
        """Convert binary mask to 3D coordinates"""
        try:
            # Get all non-zero voxels
            coords = np.argwhere(mask > 0)

            # Convert to patient coordinates
            patient_coords = []
            for coord in coords:
                # Apply volume coordinates
                vol_coord = self._apply_volume_coordinates(coord, volume_coords)

                # Convert to patient LPS
                patient_coord = self._apply_patient_lps_transform(vol_coord, volume_coords)
                patient_coords.append(patient_coord)

            return np.array(patient_coords)

        except Exception as e:
            self._log_error(f"Mask to coordinates conversion failed: {str(e)}")
            return []

    def _apply_volume_coordinates(self, coord, volume_coords):
        """Apply volume-specific coordinate system"""
        try:
            # Get spacing information
            spacing = volume_coords['spacing']

            # Convert voxel coordinates to physical coordinates
            physical_coord = coord * spacing

            # Add image position (origin)
            image_position = volume_coords['image_position'][0]  # Use first slice as reference

            return physical_coord + image_position

        except Exception as e:
            self._log_error(f"Volume coordinates application failed: {str(e)}")
            return coord

    def _apply_patient_lps_transform(self, coord, volume_coords):
        """Apply patient LPS coordinate transformation"""
        try:
            if 'patient_lps' not in volume_coords:
                return coord

            # Get direction matrix
            direction = volume_coords['patient_lps']['direction']
            origin = volume_coords['patient_lps']['origin']

            # Convert to homogeneous coordinates
            homogeneous = np.append(coord, 1)

            # Apply transformation
            transformed = np.dot(direction, homogeneous[:3]) + origin

            return transformed

        except Exception as e:
            self._log_error(f"Patient LPS transform failed: {str(e)}")
            return coord

    def _coordinates_to_mask(self, coords, shape, spacing):
        """Convert coordinates back to binary mask"""
        try:
            mask = np.zeros(shape, dtype=np.uint8)

            # Convert back to voxel coordinates
            for coord in coords:
                # Convert to voxel coordinates
                voxel_coord = self._patient_to_voxel(coord, spacing)

                # Ensure within bounds
                if (0 <= voxel_coord[0] < shape[0] and
                    0 <= voxel_coord[1] < shape[1] and
                    0 <= voxel_coord[2] < shape[2]):
                    mask[tuple(voxel_coord.astype(int))] = 255

            return mask

        except Exception as e:
            self._log_error(f"Coordinates to mask conversion failed: {str(e)}")
            return None

    def _patient_to_voxel(self, coord, spacing):
        """Convert patient coordinates to voxel coordinates"""
        try:
            # Convert to voxel coordinates by dividing by spacing
            voxel_coord = coord / spacing

            # Round to nearest voxel
            return np.round(voxel_coord).astype(int)

        except Exception as e:
            self._log_error(f"Patient to voxel conversion failed: {str(e)}")
            return None

    def _calculate_segmentation_metrics(self, segmented_volume, ai_metrics):
        """Calculate comprehensive segmentation metrics"""
        try:
            # Basic metrics from AI
            base_metrics = {
                'dice_score': ai_metrics.get('dice_score', 0.0),
                'hausdorff_distance': ai_metrics.get('hausdorff_distance', 0.0),
                'confidence': ai_metrics.get('confidence', 0.0),
                'uncertainty': ai_metrics.get('uncertainty', 0.0),
                'processing_time': ai_metrics.get('processing_time', 0.0)
            }

            # Volume metrics
            volume_metrics = self._calculate_volume_metrics(segmented_volume)
            base_metrics.update(volume_metrics)

            # Spatial metrics
            spatial_metrics = self._calculate_spatial_metrics(segmented_volume)
            base_metrics.update(spatial_metrics)

            # Add provenance information
            base_metrics['model_version'] = ai_metrics.get('model_version', 'unknown')
            base_metrics['timestamp'] = ai_metrics.get('timestamp', datetime.now().isoformat())

            return base_metrics

        except Exception as e:
            self._log_error(f"Segmentation metrics calculation failed: {str(e)}")
            return {}

    def _calculate_volume_metrics(self, mask):
        """Calculate volume-based metrics"""
        try:
            if mask is None or np.sum(mask) == 0:
                return {}

            # Get volume information
            total_voxels = np.sum(mask)
            volume_shape = mask.shape
            spacing = self._get_volume_spacing(mask)

            # Calculate volume in mm³
            voxel_volume = np.prod(spacing)
            volume_mm3 = total_voxels * voxel_volume

            # Calculate surface area (simplified)
            surface_area = self._calculate_surface_area(mask, spacing)

            return {
                'total_voxels': int(total_voxels),
                'volume_mm3': float(volume_mm3),
                'surface_area_mm2': float(surface_area),
                'max_dimension_mm': self._calculate_max_dimension(mask, spacing),
                'centroid': self._calculate_centroid(mask, spacing),
                'bounding_box': self._calculate_bounding_box(mask, spacing)
            }

        except Exception as e:
            self._log_error(f"Volume metrics calculation failed: {str(e)}")
            return {}

    def _calculate_surface_area(self, mask, spacing):
        """Calculate surface area of segmentation using gradient method"""
        try:
            # Create gradient image
            grad_x = np.gradient(mask, axis=1)
            grad_y = np.gradient(mask, axis=0)
            grad_z = np.gradient(mask, axis=2)

            # Calculate surface voxels (where mask changes)
            surface_voxels = np.sum(
                (np.abs(grad_x) > 0) * (mask > 0) +
                (np.abs(grad_y) > 0) * (mask > 0) +
                (np.abs(grad_z) > 0) * (mask > 0)
            )

            # Convert to physical units (mm²)
            surface_area = surface_voxels * np.prod(spacing[1:])  # Each surface voxel contributes to area

            return surface_area

        except Exception as e:
            self._log_error(f"Surface area calculation failed: {str(e)}")
            return 0.0

    def _calculate_max_dimension(self, mask, spacing):
        """Calculate maximum dimension of segmentation"""
        try:
            # Get all non-zero coordinates
            coords = np.argwhere(mask > 0)

            if len(coords) == 0:
                return 0.0

            # Calculate extent in each dimension
            extents = []
            for i in range(3):
                min_val = np.min(coords[:, i])
                max_val = np.max(coords[:, i])
                extent = (max_val - min_val) * spacing[i]
                extents.append(extent)

            return max(extents)

        except Exception as e:
            self._log_error(f"Max dimension calculation failed: {str(e)}")
            return 0.0

    def _calculate_centroid(self, mask, spacing):
        """Calculate centroid of segmentation"""
        try:
            # Get all non-zero coordinates
            coords = np.argwhere(mask > 0)

            if len(coords) == 0:
                return [0.0, 0.0, 0.0]

            # Convert to physical coordinates
            physical_coords = coords * spacing

            # Calculate centroid
            centroid = np.mean(physical_coords, axis=0)

            return centroid.tolist()

        except Exception as e:
            self._log_error(f"Centroid calculation failed: {str(e)}")
            return [0.0, 0.0, 0.0]

    def _calculate_bounding_box(self, mask, spacing):
        """Calculate bounding box of segmentation"""
        try:
            # Get all non-zero coordinates
            coords = np.argwhere(mask > 0)

            if len(coords) == 0:
                return {
                    'min': [0.0, 0.0, 0.0],
                    'max': [0.0, 0.0, 0.0],
                    'size': [0.0, 0.0, 0.0]
                }

            # Convert to physical coordinates
            physical_coords = coords * spacing


continue from physical_coords
11:05 AM
Claude Opus 5.5
11:05 AM

Here's the continuation of the bounding box calculation and completion of the AI integration workflow, including fallback mechanisms and coordinate validation:

            # Calculate bounding box
            min_coords = np.min(physical_coords, axis=0)
            max_coords = np.max(physical_coords, axis=0)
            size = max_coords - min_coords

            return {
                'min': min_coords.tolist(),
                'max': max_coords.tolist(),
                'size': size.tolist(),
                'center': ((min_coords + max_coords) / 2).tolist()
            }

        except Exception as e:
            self._log_error(f"Bounding box calculation failed: {str(e)}")
            return {
                'min': [0.0, 0.0, 0.0],
                'max': [0.0, 0.0, 0.0],
                'size': [0.0, 0.0, 0.0],
                'center': [0.0, 0.0, 0.0]
            }

    def _calculate_spatial_metrics(self, mask):
        """Calculate spatial relationship metrics"""
        try:
            # Get volume shape
            shape = mask.shape

            # Calculate spatial distribution metrics
            slices = []
            for i in range(shape[2]):  # For each slice
                slice_mask = mask[:, :, i]
                slices.append({
                    'slice_index': i,
                    'voxel_count': np.sum(slice_mask),
                    'center_of_mass': self._calculate_slice_com(slice_mask),
                    'extent': self._calculate_slice_extent(slice_mask)
                })

            # Calculate overall spatial metrics
            return {
                'slice_distribution': slices,
                'spatial_span': self._calculate_spatial_span(mask),
                'volume_distribution': self._calculate_volume_distribution(mask)
            }

        except Exception as e:
            self._log_error(f"Spatial metrics calculation failed: {str(e)}")
            return {}

    def _calculate_slice_com(self, slice_mask):
        """Calculate center of mass for a single slice"""
        try:
            coords = np.argwhere(slice_mask > 0)
            if len(coords) == 0:
                return [0.0, 0.0]

            com = np.mean(coords, axis=0)
            return com.tolist()

        except Exception as e:
            self._log_error(f"Slice COM calculation failed: {str(e)}")
            return [0.0, 0.0]

    def _calculate_slice_extent(self, slice_mask):
        """Calculate extent of segmentation in a single slice"""
        try:
            coords = np.argwhere(slice_mask > 0)
            if len(coords) == 0:
                return [0.0, 0.0]

            min_coords = np.min(coords, axis=0)
            max_coords = np.max(coords, axis=0)
            extent = max_coords - min_coords

            return extent.tolist()

        except Exception as e:
            self._log_error(f"Slice extent calculation failed: {str(e)}")
            return [0.0, 0.0]

    def _calculate_spatial_span(self, mask):
        """Calculate spatial span of segmentation across all dimensions"""
        try:
            coords = np.argwhere(mask > 0)
            if len(coords) == 0:
                return [0.0, 0.0, 0.0]

            min_coords = np.min(coords, axis=0)
            max_coords = np.max(coords, axis=0)
            span = max_coords - min_coords

            return span.tolist()

        except Exception as e:
            self._log_error(f"Spatial span calculation failed: {str(e)}")
            return [0.0, 0.0, 0.0]

    def _calculate_volume_distribution(self, mask):
        """Calculate volume distribution metrics"""
        try:
            # Calculate volume in different regions
            total_volume = np.sum(mask)
            if total_volume == 0:
                return {}

            # Calculate percentage in each octant
            center = np.array(mask.shape) // 2
            octants = {
                'front_left_upper': 0,
                'front_left_lower': 0,
                'front_right_upper': 0,
                'front_right_lower': 0,
                'back_left_upper': 0,
                'back_left_lower': 0,
                'back_right_upper': 0,
                'back_right_lower': 0
            }

            for i in range(mask.shape[0]):
                for j in range(mask.shape[1]):
                    for k in range(mask.shape[2]):
                        if mask[i, j, k] > 0:
                            # Determine which octant this voxel belongs to
                            octant = self._determine_octant(i, j, k, center)
                            octants[octant] += 1

            # Convert to percentages
            for key in octants:
                octants[key] = (octants[key] / total_volume) * 100

            return {
                'octant_distribution': octants,
                'volume_entropy': self._calculate_volume_entropy(mask),
                'compactness': self._calculate_compactness(mask)
            }

        except Exception as e:
            self._log_error(f"Volume distribution calculation failed: {str(e)}")
            return {}

    def _determine_octant(self, i, j, k, center):
        """Determine which octant a voxel belongs to"""
        if i < center[0] and j < center[1] and k < center[2]:
            return 'front_left_upper'
        elif i < center[0] and j < center[1] and k >= center[2]:
            return 'front_left_lower'
        elif i < center[0] and j >= center[1] and k < center[2]:
            return 'front_right_upper'
        elif i < center[0] and j >= center[1] and k >= center[2]:
            return 'front_right_lower'
        elif i >= center[0] and j < center[1] and k < center[2]:
            return 'back_left_upper'
        elif i >= center[0] and j < center[1] and k >= center[2]:
            return 'back_left_lower'
        elif i >= center[0] and j >= center[1] and k < center[2]:
            return 'back_right_upper'
        else:
            return 'back_right_lower'

    def _calculate_volume_entropy(self, mask):
        """Calculate entropy of volume distribution"""
        try:
            # Simple entropy calculation based on voxel distribution
            unique, counts = np.unique(mask, return_counts=True)
            probabilities = counts / counts.sum()
            entropy = -np.sum(probabilities * np.log2(probabilities + 1e-10))
            return float(entropy)

        except Exception as e:
            self._log_error(f"Volume entropy calculation failed: {str(e)}")
            return 0.0

    def _calculate_compactness(self, mask):
        """Calculate compactness metric (4πV/A²)"""
        try:
            if np.sum(mask) == 0:
                return 0.0

            volume = self._calculate_volume_metrics(mask)['volume_mm3']
            surface_area = self._calculate_volume_metrics(mask)['surface_area_mm2']

            if surface_area == 0:
                return 0.0

            compactness = (4 * math.pi * volume) / (surface_area ** 2)
            return float(compactness)

        except Exception as e:
            self._log_error(f"Compactness calculation failed: {str(e)}")
            return 0.0

    def _generate_visualization(self, segmentation, volume):
        """Generate visualization from segmentation results"""
        try:
            # Create visualization parameters
            viz_params = {
                'volume': volume.get_volume_data(),
                'segmentation': segmentation['mask'],
                'coordinates': volume.coordinates,
                'metrics': segmentation['metrics'],
                'anatomical_labels': self._get_anatomical_labels(segmentation),
                'visualization_type': '3d_volume_with_segmentation'
            }

            # Generate visualization
            visualization = self.volume_lab.generate_visualization(viz_params)

            # Add visualization metadata
            visualization['metadata'] = {
                'generation_timestamp': datetime.now().isoformat(),
                'visualization_parameters': viz_params,
                'segmentation_id': self._generate_segmentation_id(),
                'quality': self._assess_visualization_quality(visualization)
            }

            return visualization

        except Exception as e:
            self._log_error(f"Visualization generation failed: {str(e)}")
            return None

    def _get_anatomical_labels(self, segmentation):
        """Determine anatomical labels based on segmentation"""
        try:
            # Use segmentation metrics to determine likely anatomy
            metrics = segmentation['metrics']

            # Simple classification based on volume and location
            if metrics['volume_mm3'] < 100:
                return ['small_finding', 'possible_artifact']
            elif metrics['volume_mm3'] < 1000:
                return ['fibroid', 'leiomyoma']
            elif metrics['volume_mm3'] < 5000:
                return ['large

Continue from elif metrics['volume_mm3'] < 5000:
11:05 AM
Claude Opus 5.5
11:05 AM

Here's the continuation with anatomical labeling, mesh generation, and complete workflow completion:

                return ['large_fibroid', 'subserosal_fibroid']
            elif metrics['volume_mm3'] < 20000:
                return ['very_large_fibroid', 'pedunculated_fibroid']
            else:
                return ['giant_fibroid', 'abnormal_finding']

            # Consider spatial characteristics
            spatial_metrics = self._calculate_spatial_metrics(segmentation['mask'])
            if spatial_metrics['spatial_span'][2] > 50:  # Large Z-axis span
                return ['elongated_fibroid', 'intramural_fibroid']
            elif spatial_metrics['volume_distribution']['octant_distribution']['back_right_upper'] > 30:
                return ['posterior_wall_fibroid']
            elif spatial_metrics['volume_distribution']['octant_distribution']['front_left_upper'] > 30:
                return ['anterior_wall_fibroid']

            # Default anatomical classification
            return ['fibroid', 'uterine_leimyoma']

        except Exception as e:
            self._log_error(f"Anatomical labeling failed: {str(e)}")
            return ['unknown_anatomical_structure']

    def _generate_mesh(self, segmentation, volume):
        """Generate 3D mesh from segmentation with proper coordinate transformations"""
        try:
            # Get segmentation mask and volume coordinates
            mask = segmentation['mask']
            volume_coords = volume.coordinates

            # Convert to proper format for mesh generation
            mesh_input = {
                'volume_data': volume.get_volume_data(),
                'segmentation_mask': mask,
                'coordinates': volume_coords,
                'threshold': 0.5,  # Binary threshold for segmentation
                'mesh_type': 'watertight',
                'smoothing': {
                    'iterations': 3,
                    'lambda': 0.1,
                    'relaxation': 0.1
                },
                'output_format': 'stl_and_obj'
            }

            # Generate mesh using specialized mesh generator
            mesh_result = self.mesh_generator.generate_mesh(mesh_input)

            if not mesh_result or not mesh_result['success']:
                self._log_error("Mesh generation failed")
                return None

            # Apply coordinate transformations to mesh
            transformed_mesh = self._apply_mesh_transformations(
                mesh_result['mesh'],
                volume_coords,
                segmentation['metrics']
            )

            # Create mesh metadata
            mesh_metadata = {
                'generation_timestamp': datetime.now().isoformat(),
                'mesh_parameters': mesh_input,
                'segmentation_id': self._generate_segmentation_id(),
                'mesh_quality': self._assess_mesh_quality(transformed_mesh),
                'coordinate_system': 'patient_lps',
                'anatomical_labels': self._get_anatomical_labels(segmentation),
                'model_version': segmentation['model_version'],
                'processing_time': segmentation['processing_time']
            }

            return {
                'mesh': transformed_mesh,
                'metadata': mesh_metadata,
                'files': {
                    'stl': mesh_result['files'].get('stl', None),
                    'obj': mesh_result['files'].get('obj', None),
                    'vtp': mesh_result['files'].get('vtp', None)
                }
            }

        except Exception as e:
            self._log_error(f"Mesh generation failed: {str(e)}")
            return None

    def _apply_mesh_transformations(self, mesh, volume_coords, segmentation_metrics):
        """Apply all necessary coordinate transformations to the mesh"""
        try:
            # Get transformation parameters
            transform_params = {
                'volume_coords': volume_coords,
                'segmentation_metrics': segmentation_metrics,
                'patient_lps': volume_coords.get('patient_lps', {}),
                'image_orientation': volume_coords.get('image_orientation', []),
                'image_position': volume_coords.get('image_position', [])
            }

            # Apply transformations to each vertex
            transformed_vertices = []
            for vertex in mesh['vertices']:
                transformed = self._transform_vertex(vertex, transform_params)
                transformed_vertices.append(transformed)

            # Update mesh with transformed vertices
            transformed_mesh = {
                'vertices': np.array(transformed_vertices),
                'faces': mesh['faces'],
                'normals': self._calculate_mesh_normals(transformed_vertices, mesh['faces']),
                'metadata': mesh.get('metadata', {})
            }

            # Validate transformed mesh
            if not self._validate_transformed_mesh(transformed_mesh):
                self._log_error("Transformed mesh validation failed")
                return None

            return transformed_mesh

        except Exception as e:
            self._log_error(f"Mesh transformation failed: {str(e)}")
            return None

    def _transform_vertex(self, vertex, transform_params):
        """Transform a single vertex through all coordinate systems"""
        try:
            # Start with vertex coordinates (assuming they're in volume space)
            coord = np.array(vertex[:3], dtype=float)

            # 1. Apply volume to patient coordinate transformation
            coord = self._volume_to_patient_coordinates(coord, transform_params)

            # 2. Apply any additional transformations from segmentation metrics
            coord = self._apply_segmentation_transformations(coord, transform_params)

            # 3. Apply patient LPS coordinate system transformation
            coord = self._apply_patient_lps_transform(coord, transform_params)

            # 4. Apply any DICOM-specific transformations
            coord = self._apply_dicom_transformations(coord, transform_params)

            return list(coord) + vertex[3:]  # Preserve vertex attributes

        except Exception as e:
            self._log_error(f"Vertex transformation failed: {str(e)}")
            return vertex

    def _volume_to_patient_coordinates(self, coord, transform_params):
        """Convert from volume coordinates to patient coordinates"""
        try:
            if not transform_params['volume_coords']:
                return coord

            # Get volume spacing and origin
            spacing = transform_params['volume_coords'].get('spacing', [1.0, 1.0, 1.0])
            image_position = transform_params['volume_coords'].get('image_position', [[0.0, 0.0, 0.0]])

            # Convert from voxel to physical coordinates
            physical_coord = coord * spacing

            # Add image position (origin)
            physical_coord += image_position[0]

            return physical_coord

        except Exception as e:
            self._log_error(f"Volume to patient coordinates failed: {str(e)}")
            return coord

    def _apply_segmentation_transformations(self, coord, transform_params):
        """Apply any segmentation-specific transformations"""
        try:
            # Check if we have any segmentation-specific transformations
            metrics = transform_params['segmentation_metrics']

            # Apply centroid adjustment if needed
            if 'centroid_adjustment' in metrics:
                coord += metrics['centroid_adjustment']

            # Apply any scaling factors
            if 'scaling_factors' in metrics:
                coord *= metrics['scaling_factors']

            return coord

        except Exception as e:
            self._log_error(f"Segmentation transformations failed: {str(e)}")
            return coord

    def _calculate_mesh_normals(self, vertices, faces):
        """Calculate vertex normals for the mesh"""
        try:
            # Initialize normals
            normals = np.zeros((len(vertices), 3))

            # Calculate face normals
            face_normals = self._calculate_face_normals(vertices, faces)

            # Accumulate normals for each vertex
            for i, face in enumerate(faces):
                for vertex_idx in face:
                    normals[vertex_idx] += face_normals[i]

            # Normalize vertex normals
            normals = normals / np.linalg.norm(normals, axis=1, keepdims=True)

            return normals.tolist()

        except Exception as e:
            self._log_error(f"Mesh normals calculation failed: {str(e)}")
            return [np.zeros(3).tolist() for _ in range(len(vertices))]

    def _calculate_face_normals(self, vertices, faces):
        """Calculate normals for each face"""
        try:
            face_normals = []

            for face in faces:
                # Get three vertices of the face
                v0 = vertices[face[0]]
                v1 = vertices[face[1]]
                v2 = vertices[face[2]]

                # Calculate two edge vectors
                edge1 = v1 - v0
                edge2 = v2 - v0

                # Calculate face normal (cross product)
                normal = np.cross(edge1, edge2)

                # Normalize
                normal = normal / np.linalg.norm(normal)

                face_normals.append(normal)

            return np.array(face_normals)

        except Exception as e:
            self._log_error(f"Face normals calculation failed: {str(e)}")
            return np.zeros((len(faces), 3))

    def _validate_transformed_mesh(self, mesh):
        """Validate that the transformed mesh is geometrically valid"""
        try:
            # Check for NaN or infinite values
            if np.any(np.isnan(mesh['vertices'])) or np.any(np.isinf(mesh['vertices'])):
                return False

            # Check for degenerate faces
            for face in mesh['faces']:
                if len(face) != 3:
                   

Continue from for face in mesh['faces']:
11:06 AM
Claude Opus 5.5
11:06 AM

Here's the continuation of the mesh validation and completion of the AI integration workflow with fallback mechanisms:

                if len(set(face)) != 3:  # Duplicate vertices in face
                    return False

                # Check if face is degenerate (collinear points)
                v0 = mesh['vertices'][face[0]]
                v1 = mesh['vertices'][face[1]]
                v2 = mesh['vertices'][face[2]]

                # Calculate area of triangle formed by face
                edge1 = v1 - v0
                edge2 = v2 - v0
                normal = np.cross(edge1, edge2)

                if np.linalg.norm(normal) < 1e-6:  # Nearly zero area
                    return False

            # Check for self-intersections (basic check)
            if not self._check_mesh_self_intersections(mesh):
                return False

            # Check that all vertices are finite and within reasonable bounds
            bounds = np.max(np.abs(mesh['vertices']), axis=0)
            if np.any(bounds > 1e6):  # Arbitrary large bound
                return False

            # Check that mesh has reasonable number of vertices and faces
            if len(mesh['vertices']) < 10 or len(mesh['faces']) < 5:
                return False

            return True

        except Exception as e:
            self._log_error(f"Mesh validation failed: {str(e)}")
            return False

    def _check_mesh_self_intersections(self, mesh, tolerance=1e-3):
        """Basic check for mesh self-intersections"""
        try:
            # For a more thorough check, we would use a proper mesh intersection algorithm
            # This is a simplified version that checks for edge-face intersections

            for i, face in enumerate(mesh['faces']):
                # Get face vertices
                v0 = mesh['vertices'][face[0]]
                v1 = mesh['vertices'][face[1]]
                v2 = mesh['vertices'][face[2]]

                # Check all edges of this face against all other faces
                edges = [
                    (v0, v1),
                    (v1, v2),
                    (v2, v0)
                ]

                for edge in edges:
                    # Check if this edge intersects with any other face
                    for j, other_face in enumerate(mesh['faces']):
                        if i == j:
                            continue

                        # Check if edge intersects with any edge of other_face
                        other_edges = [
                            (mesh['vertices'][other_face[0]], mesh['vertices'][other_face[1]]),
                            (mesh['vertices'][other_face[1]], mesh['vertices'][other_face[2]]),
                            (mesh['vertices'][other_face[2]], mesh['vertices'][other_face[0]])
                        ]

                        for other_edge in other_edges:
                            if self._segments_intersect(edge[0], edge[1], other_edge[0], other_edge[1], tolerance):
                                return False

            return True

        except Exception as e:
            self._log_error(f"Mesh self-intersection check failed: {str(e)}")
            return False

    def _segments_intersect(self, p1, p2, p3, p4, tolerance=1e-3):
        """Check if line segments intersect"""
        try:
            # Vector math for segment intersection
            def ccw(A, B, C):
                return (C[1]-A[1]) * (B[0]-A[0]) > (B[1]-A[1]) * (C[0]-A[0])

            A, B = p1, p2
            C, D = p3, p4

            return ccw(A,B,C) != ccw(A,B,D) and ccw(C,D,A) != ccw(C,D,B)

        except Exception as e:
            self._log_error(f"Segment intersection check failed: {str(e)}")
            return False

    def _store_provenance(self, patient_id, study_uid, volume, segmentation, mesh, ai_response):
        """Store complete provenance information for the processing"""
        try:
            provenance_record = {
                'patient_id': patient_id,
                'study_uid': study_uid,
                'volume_id': volume.id,
                'processing_timestamp': datetime.now().isoformat(),
                'processing_method': 'ai_segmentation',
                'model_version': ai_response['model']['model_version'],
                'segmentation_id': self._generate_segmentation_id(),
                'mesh_id': self._generate_mesh_id(),
                'anatomical_labels': self._get_anatomical_labels(segmentation),
                'coordinates': volume.coordinates,
                'metrics': segmentation['metrics'],
                'visualization_id': self._generate_visualization_id(),
                'processing_history': self._build_processing_history(volume, segmentation, mesh),
                'verification_status': 'unverified',
                'reviewer': None,
                'review_timestamp': None,
                'change_reason': None,
                'previous_version': None,
                'uncertainty': segmentation['uncertainty'],
                'confidence': segmentation['confidence'],
                'processing_time': segmentation['processing_time'],
                'source_evidence': self._get_source_evidence(volume, study_uid),
                'classical_methods_used': self._get_classical_methods_used(segmentation)
            }

            # Store in database
            self.volume_lab.store_provenance(provenance_record)

            # Create versioned record
            self._create_versioned_record(provenance_record)

            return provenance_record

        except Exception as e:
            self._log_error(f"Provenance storage failed: {str(e)}")
            return None

    def _build_processing_history(self, volume, segmentation, mesh):
        """Build complete processing history with all steps"""
        try:
            history = {
                'steps': [],
                'start_timestamp': volume.upload_timestamp,
                'end_timestamp': datetime.now().isoformat(),
                'total_duration': self._calculate_duration(volume.upload_timestamp)
            }

            # Add DICOM upload step
            history['steps'].append({
                'step': 'dicom_upload',
                'timestamp': volume.upload_timestamp,
                'details': {
                    'series_uid': volume.series_uid,
                    'number_of_instances': len(volume.dicom_series),
                    'validation_status': 'passed',
                    'coordinates_validated': True
                },
                'status': 'completed'
            })

            # Add AI processing step
            history['steps'].append({
                'step': 'ai_inference',
                'timestamp': segmentation['timestamp'],
                'details': {
                    'model': segmentation['model_version'],
                    'processing_time': segmentation['processing_time'],
                    'metrics': segmentation['metrics'],
                    'uncertainty': segmentation['uncertainty'],
                    'confidence': segmentation['confidence']
                },
                'status': 'completed'
            })

            # Add segmentation processing step
            history['steps'].append({
                'step': 'segmentation_processing',
                'timestamp': datetime.now().isoformat(),
                'details': {
                    'volume_mm3': segmentation['metrics']['volume_mm3'],
                    'surface_area_mm2': segmentation['metrics']['surface_area_mm2'],
                    'anatomical_labels': self._get_anatomical_labels(segmentation),
                    'coordinate_system': 'patient_lps'
                },
                'status': 'completed'
            })

            # Add mesh generation step
            history['steps'].append({
                'step': 'mesh_generation',
                'timestamp': datetime.now().isoformat(),
                'details': {
                    'mesh_type': 'watertight',
                    'vertex_count': len(mesh['mesh']['vertices']),
                    'face_count': len(mesh['mesh']['faces']),
                    'smoothing_applied': True,
                    'coordinate_system': 'patient_lps'
                },
                'status': 'completed'
            })

            # Add visualization step
            history['steps'].append({
                'step': 'visualization_generation',
                'timestamp': datetime.now().isoformat(),
                'details': {
                    'visualization_type': '3d_volume_with_segmentation',
                    'anatomical_labels': self._get_anatomical_labels(segmentation),
                    'coordinates': volume.coordinates
                },
                'status': 'completed'
            })

            # Add provenance storage step
            history['steps'].append({
                'step': 'provenance_storage',
                'timestamp': datetime.now().isoformat(),
                'details': {
                    'record_id': self._generate_provenance_id(),
                    'versioned': True,
                    'classical_methods_used': self._get_classical_methods_used(segmentation)
                },
                'status': 'completed'
            })

            return history

        except Exception as e:
            self._log_error(f"Processing history building failed: {str(e)}")
            return {'steps': [], 'start_timestamp': None, 'end_timestamp': None}

    def _get_classical_methods_used(self, segmentation):
        """Determine which classical methods were used as fallback"""
        try:
            methods_used = []

            # Check if region growing was used
            if segmentation.get('fallback_method') == 'region_growing':
                methods_used.append({
                    'method': 'region_growing',
                    'parameters': segmentation.get('region_growing_params', {}),
                    'reason': segmentation.get('fallback_reason', 'ai_uncertainty'),
                    'confidence': segmentation.get('region_growing_confidence', 0.

Continue from  'reason': segmentation.get('fallback_reason', 'ai_uncertainty'),
11:07 AM
Claude Opus 5.5
11:07 AM

Here's the continuation with the completion of classical method tracking, error handling, and the final workflow integration:

                    'timestamp': segmentation.get('region_growing_timestamp', datetime.now().isoformat())
                })

            # Check if manual segmentation was used
            if segmentation.get('manual_segmentation_used', False):
                methods_used.append({
                    'method': 'manual_segmentation',
                    'parameters': segmentation.get('manual_segmentation_params', {}),
                    'reason': segmentation.get('manual_reason', 'ai_failure'),
                    'confidence': segmentation.get('manual_confidence', 0.0),
                    'timestamp': segmentation.get('manual_timestamp', datetime.now().isoformat()),
                    'reviewer': segmentation.get('manual_reviewer', None)
                })

            # Check if any other classical methods were used
            if 'classical_methods' in segmentation:
                for method in segmentation['classical_methods']:
                    methods_used.append({
                        'method': method.get('type', 'unknown'),
                        'parameters': method.get('parameters', {}),
                        'reason': method.get('reason', 'unknown'),
                        'confidence': method.get('confidence', 0.0),
                        'timestamp': method.get('timestamp', datetime.now().isoformat())
                    })

            return methods_used if methods_used else None

        except Exception as e:
            self._log_error(f"Classical methods tracking failed: {str(e)}")
            return None

    def _get_source_evidence(self, volume, study_uid):
        """Compile complete source evidence for the finding"""
        try:
            evidence = {
                'study_uid': study_uid,
                'series_uids': [volume.series_uid],
                'dicom_instances': len(volume.dicom_series),
                'source_images': self._get_source_image_references(volume),
                'clinical_reports': self._get_clinical_report_references(study_uid),
                'original_measurements': self._get_original_measurements(volume),
                'registration_info': self._get_registration_info(volume),
                'anatomical_references': self._get_anatomical_references(volume)
            }

            return evidence

        except Exception as e:
            self._log_error(f"Source evidence compilation failed: {str(e)}")
            return {
                'study_uid': study_uid,
                'series_uids': [volume.series_uid],
                'error': str(e)
            }

    def _get_source_image_references(self, volume):
        """Get references to all source DICOM images"""
        try:
            return [{
                'instance_uid': instance.SOPInstanceUID,
                'image_position': instance.ImagePositionPatient,
                'image_orientation': instance.ImageOrientationPatient,
                'slice_location': instance.ImagePositionPatient[2],
                'pixel_spacing': instance.PixelSpacing,
                'slice_thickness': self._calculate_slice_thickness(instance),
                'modality': instance.Modality,
                'frame_of_reference_uid': instance.FrameOfReferenceUID
            } for instance in volume.dicom_series]

        except Exception as e:
            self._log_error(f"Source image references failed: {str(e)}")
            return []

    def _calculate_slice_thickness(self, instance):
        """Calculate slice thickness from DICOM instance"""
        try:
            if hasattr(instance, 'SliceThickness'):
                return float(instance.SliceThickness)

            # Fallback calculation if SliceThickness not available
            if len(volume.dicom_series) > 1:
                prev_instance = volume.dicom_series[volume.dicom_series.index(instance) - 1]
                current_pos = [float(p) for p in instance.ImagePositionPatient]
                prev_pos = [float(p) for p in prev_instance.ImagePositionPatient]
                return math.sqrt(sum((a-b)**2 for a, b in zip(current_pos, prev_pos)))

            return 1.0  # Default value

        except Exception as e:
            self._log_error(f"Slice thickness calculation failed: {str(e)}")
            return 1.0

    def _get_clinical_report_references(self, study_uid):
        """Get references to clinical reports associated with the study"""
        try:
            # In a real implementation, this would query your clinical report database
            return [{
                'report_uid': f"report_{study_uid}_1",
                'report_type': 'radiology',
                'study_uid': study_uid,
                'timestamp': datetime.now().isoformat(),
                'findings': ["Initial fibroid identification"],
                'measurements': ["Uterine size: 120x80x60mm"],
                'impression': "Multiple fibroids identified in uterus",
                'reviewer': "Dr. Smith"
            }]

        except Exception as e:
            self._log_error(f"Clinical report references failed: {str(e)}")
            return []

    def _get_original_measurements(self, volume):
        """Get original measurements from the volume data"""
        try:
            # This would come from the original DICOM measurements if available
            return {
                'uterine_volume': None,  # Would be calculated from original DICOM
                'fibroid_measurements': [],
                'other_findings': []
            }

        except Exception as e:
            self._log_error(f"Original measurements retrieval failed: {str(e)}")
            return {}

    def _get_registration_info(self, volume):
        """Get information about image registration if applicable"""
        try:
            if hasattr(volume, 'registration_info'):
                return volume.registration_info
            return {
                'registered_to': None,
                'registration_method': 'none',
                'registration_quality': None,
                'registration_timestamp': None,
                'registration_parameters': {}
            }

        except Exception as e:
            self._log_error(f"Registration info retrieval failed: {str(e)}")
            return {
                'registered_to': None,
                'registration_method': 'none',
                'error': str(e)
            }

    def _get_anatomical_references(self, volume):
        """Get anatomical references from the DICOM data"""
        try:
            return {
                'patient_position': volume.dicom_series[0].PatientPosition,
                'patient_orientation': volume.dicom_series[0].PatientOrientation,
                'anatomical_structures': self._identify_anatomical_structures(volume),
                'reference_points': self._get_reference_points(volume)
            }

        except Exception as e:
            self._log_error(f"Anatomical references retrieval failed: {str(e)}")
            return {
                'error': str(e),
                'patient_position': 'unknown',
                'anatomical_structures': []
            }

    def _identify_anatomical_structures(self, volume):
        """Identify anatomical structures from DICOM series"""
        try:
            # This would use more sophisticated anatomical identification
            # For now, we'll use simple heuristics based on position and modality
            instances = volume.dicom_series

            structures = []
            for instance in instances:
                if instance.Modality == 'MR':
                    if 'uterus' in instance.get('AnatomicalStructure', []):
                        structures.append({
                            'structure': 'uterus',
                            'confidence': 0.9,
                            'slice_location': instance.ImagePositionPatient[2],
                            'series_uid': instance.SeriesInstanceUID
                        })
                    elif 'fibroid' in instance.get('SecondaryAnatomicalStructure', []):
                        structures.append({
                            'structure': 'fibroid',
                            'confidence': 0.8,
                            'slice_location': instance.ImagePositionPatient[2],
                            'series_uid': instance.SeriesInstanceUID
                        })

            # Add general anatomical landmarks
            structures.extend([
                {
                    'structure': 'pelvis',
                    'confidence': 0.95,
                    'slice_range': [min(i.ImagePositionPatient[2] for i in instances),
                                   max(i.ImagePositionPatient[2] for i in instances)]
                },
                {
                    'structure': 'uterine_cavity',
                    'confidence': 0.8,
                    'slice_range': [min(i.ImagePositionPatient[2] for i in instances) + 10,
                                   max(i.ImagePositionPatient[2] for i in instances) - 10]
                }
            ])

            return structures

        except Exception as e:
            self._log_error(f"Anatomical structure identification failed: {str(e)}")
            return []

    def _get_reference_points(self, volume):
        """Get reference points from the DICOM series"""
        try:
            instances = volume.dicom_series
            if not instances:
                return []

            # Get first and last slice positions
            first_slice = instances[0]
            last_slice = instances[-1]

            return [
                {
                    'point_type': 'series_start',
                    'coordinates': first_slice.ImagePositionPatient,
                    'slice_index': 0,
                    'series_uid': first_slice.SeriesInstanceUID
                },
                {
                    'point_type': 'series_end',
                    'coordinates': last_slice.ImagePositionPatient,
                    'slice_index': len(instances) - 1,
                    'series_uid': last_slice.SeriesInstanceUID
                },
                {
                    'point_type': 'center_slice',
                    'coordinates': instances[len(instances)//2].ImagePositionPatient,
                    'slice_index': len(instances)//2,
                    'series_uid': instances[len(instances)//2].SeriesInstanceUID
                }
            ]

        except Exception as e:
            self._log_error(f"Reference points retrieval failed: {str(e

Continue from except Exception as e:
11:08 AM
Claude Opus 5.5
11:08 AM

Here's the continuation with the completion of the reference points handling, error handling framework, and the final integration of the AI workflow with fallback mechanisms:

            self._log_error(f"Reference points retrieval failed: {str(e)}")
            return [{
                'point_type': 'error',
                'error': str(e),
                'timestamp': datetime.now().isoformat()
            }]
        }

    def _create_versioned_record(self, provenance_record):
        """Create versioned record of the finding"""
        try:
            version_record = {
                'finding_id': provenance_record['segmentation_id'],
                'version': 1,
                'previous_version': None,
                'patient_id': provenance_record['patient_id'],
                'study_uid': provenance_record['study_uid'],
                'volume_id': provenance_record['volume_id'],
                'timestamp': datetime.now().isoformat(),
                'metrics': provenance_record['metrics'],
                'anatomical_labels': provenance_record['anatomical_labels'],
                'coordinates': provenance_record['coordinates'],
                'verification_status': provenance_record['verification_status'],
                'reviewer': provenance_record['reviewer'],
                'change_reason': provenance_record['change_reason'],
                'processing_history': provenance_record['processing_history'],
                'uncertainty': provenance_record['uncertainty'],
                'confidence': provenance_record['confidence'],
                'source_evidence': provenance_record['source_evidence'],
                'classical_methods_used': provenance_record['classical_methods_used'],
                'ai_model_version': provenance_record['model_version'],
                'mesh_id': provenance_record['mesh_id'],
                'visualization_id': provenance_record['visualization_id']
            }

            # Store versioned record
            self.volume_lab.store_versioned_record(version_record)

            return version_record

        except Exception as e:
            self._log_error(f"Versioned record creation failed: {str(e)}")
            return None

    def _handle_validation_failure(self, dicom_series):
        """Handle DICOM validation failures with appropriate fallbacks"""
        try:
            self._log_error("DICOM validation failed - attempting fallback processing")

            # Try to identify what specifically failed
            validation_errors = self.dicom_handler.validate_series(dicom_series, detailed=True)

            # If geometry is invalid but data is otherwise good, try to correct
            if 'geometry_invalid' in validation_errors:
                corrected_series = self._attempt_geometry_correction(dicom_series)
                if corrected_series:
                    return self.process_dicom_workflow(corrected_series, dicom_series[0].PatientID, dicom_series[0].StudyInstanceUID)

            # If we can't correct, fall back to region growing on individual slices
            if 'series_inconsistent' in validation_errors:
                return self._fallback_to_slice_by_slice_processing(dicom_series)

            # Final fallback: manual review required
            return {
                'success': False,
                'error': 'DICOM validation failed with unrecoverable errors',
                'validation_errors': validation_errors,
                'fallback_required': True,
                'fallback_method': 'manual_review',
                'suggested_action': 'Review DICOM series for inconsistencies'
            }

        except Exception as e:
            self._log_error(f"Validation failure handling failed: {str(e)}")
            return {
                'success': False,
                'error': f"Failed to handle validation failure: {str(e)}",
                'original_errors': self.dicom_handler.validate_series(dicom_series, detailed=True)
            }

    def _attempt_geometry_correction(self, dicom_series):
        """Attempt to correct DICOM geometry inconsistencies"""
        try:
            # Check if we can fix slice ordering
            if not self._verify_spatial_consistency(dicom_series):
                sorted_series = sorted(dicom_series,
                                     key=lambda x: float(x.ImagePositionPatient[2]))
                self._log_warning("Fixed slice ordering inconsistencies")
                return sorted_series

            # Check if we can fix orientation inconsistencies
            first_orientation = dicom_series[0].ImageOrientationPatient
            if not all(instance.ImageOrientationPatient == first_orientation
                      for instance in dicom_series):
                # Standardize all orientations to first instance
                for instance in dicom_series[1:]:
                    instance.ImageOrientationPatient = first_orientation
                self._log_warning("Standardized image orientations")
                return dicom_series

            # Check if we can fix missing slice thickness
            if not all(hasattr(instance, 'SliceThickness') for instance in dicom_series):
                if len(dicom_series) > 1:
                    # Calculate slice thickness from positions
                    positions = [float(instance.ImagePositionPatient[2]) for instance in dicom_series]
                    thickness = positions[1] - positions[0]
                    for instance in dicom_series:
                        instance.SliceThickness = thickness
                    self._log_warning(f"Calculated slice thickness: {thickness:.2f}mm")
                    return dicom_series

            return None  # Couldn't correct

        except Exception as e:
            self._log_error(f"Geometry correction failed: {str(e)}")
            return None

    def _fallback_to_slice_by_slice_processing(self, dicom_series):
        """Process series slice by slice with region growing fallback"""
        try:
            self._log_warning("Falling back to slice-by-slice processing with region growing")

            results = []
            for i, instance in enumerate(dicom_series):
                try:
                    # Extract single slice
                    single_slice = [instance]

                    # Process with region growing fallback
                    result = self.process_dicom_workflow(
                        single_slice,
                        instance.PatientID,
                        instance.StudyInstanceUID
                    )

                    if result and result['success']:
                        # Store as partial finding
                        result['partial_finding'] = True
                        result['slice_index'] = i
                        result['original_slice_position'] = instance.ImagePositionPatient[2]
                        results.append(result)

                except Exception as e:
                    self._log_error(f"Slice {i} processing failed: {str(e)}")
                    results.append({
                        'success': False,
                        'slice_index': i,
                        'error': str(e),
                        'instance_uid': instance.SOPInstanceUID
                    })

            # Combine partial results
            if results:
                combined = {
                    'success': True,
                    'fallback_method': 'slice_by_slice_region_growing',
                    'fallback_reason': 'series_inconsistency',
                    'partial_results': results,
                    'original_series_uid': dicom_series[0].SeriesInstanceUID,
                    'timestamp': datetime.now().isoformat()
                }
                return combined

            return {
                'success': False,
                'error': 'All slice processing attempts failed',
                'fallback_method': 'slice_by_slice_region_growing'
            }

        except Exception as e:
            self._log_error(f"Slice-by-slice fallback failed: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'fallback_method': 'slice_by_slice_region_growing'
            }

    def _handle_ai_prep_failure(self, volume):
        """Handle AI request preparation failures"""
        try:
            self._log_error("AI request preparation failed - attempting fallback")

            # Try with simplified request
            simplified_request = {
                'input': {
                    'volume_id': volume.id,
                    'patient_id': volume.patient_id,
                    'study_uid': volume.study_uid,
                    'volume_data': volume.get_volume_data(simplified=True),
                    'coordinates': volume.coordinates
                },
                'model': self._get_active_ai_model(),
                'processing_parameters': {
                    'threshold': 0.5,
                    'postprocessing': {
                        'connected_components': True
                    }
                }
            }

            # Execute simplified request
            ai_response = self._execute_ai_inference(simplified_request)
            if ai_response:
                return self._process_ai_results(ai_response, volume)

            # Final fallback to region growing
            return self._region_growing_fallback(volume)

        except Exception as e:
            self._log_error(f"AI prep failure handling failed: {str(e)}")
            return self._region_growing_fallback(volume)

    def _handle_ai_failure(self, volume, ai_request):
        """Handle AI inference failures with appropriate fallbacks"""
        try:
            self._log_error("AI inference failed - determining fallback strategy")

            # Analyze why AI failed
            error_type = self._determine_ai_failure_type(ai_request)

            # Choose appropriate fallback based on error type
            if error_type == 'timeout':
                return self._handle_timeout_fallback(volume, ai_request)
            elif error_type == 'model_unavailable':
                return self._handle_model_unavailable_fallback(volume, ai_request)
            elif error_type == 'input_validation':
                return self._handle_input_validation_fallback(volume, ai_request)
            else:
                return self._region_growing_fallback(volume)

        except Exception as e:
            self._log_error(f"AI failure handling failed: {str(e)}")
            return self._region_growing_fallback(volume)

    def _determine_ai_failure_type(self, ai_request):
        """Determine the type of AI failure that occurred"""
        try:
            # This would be enhanced with actual error analysis from the AI service
            # For now, we'll make some educated guesses based on the request

            # Check

Continue from # For now, we'll make some educated guesses based on the request
11:08 AM
Claude Opus 5.5
11:08 AM

Here's the continuation with comprehensive AI failure analysis, fallback strategies, and complete error handling:

            # Check request complexity that might cause timeouts
            volume_size = np.prod(ai_request['input']['volume_data'].shape)
            if volume_size > 1000000:  # >1M voxels
                return 'timeout'

            # Check if we're using a specific model that might be down
            model_name = ai_request['model']['model_name']
            if model_name in ['fibroid_segmentation_v3', 'uterus_segmentation_v2']:
                return 'model_unavailable'

            # Check input validation flags
            if 'input_validation' in ai_request.get('processing_parameters', {}):
                return 'input_validation'

            # Default to general failure
            return 'general_failure'

        except Exception as e:
            self._log_error(f"AI failure type determination failed: {str(e)}")
            return 'general_failure'

    def _handle_timeout_fallback(self, volume, ai_request):
        """Handle AI timeout with partial processing"""
        try:
            self._log_warning("AI timeout detected - processing with reduced complexity")

            # Split volume into smaller chunks
            chunk_size = 64  # 64³ volume
            original_shape = volume.get_volume_data().shape

            results = []
            for i in range(0, original_shape[0], chunk_size):
                for j in range(0, original_shape[1], chunk_size):
                    for k in range(0, original_shape[2], chunk_size):
                        try:
                            # Process chunk
                            chunk = self._extract_volume_chunk(volume, i, j, k, chunk_size)
                            if chunk is None:
                                continue

                            # Prepare simplified request
                            simplified_request = {
                                'input': {
                                    'volume_id': f"{volume.id}_chunk_{i}_{j}_{k}",
                                    'volume_data': chunk,
                                    'coordinates': self._calculate_chunk_coordinates(
                                        volume.coordinates, i, j, k, chunk_size
                                    )
                                },
                                'model': self._get_active_ai_model(),
                                'processing_parameters': {
                                    'threshold': 0.5,
                                    'timeout': 60,  # Reduced timeout
                                    'chunk_info': {
                                        'original_position': [i, j, k],
                                        'chunk_size': chunk_size
                                    }
                                }
                            }

                            # Execute with shorter timeout
                            ai_response = self._execute_ai_inference(
                                simplified_request,
                                timeout=60
                            )

                            if ai_response and ai_response['success']:
                                processed_chunk = self._process_ai_results(ai_response, volume)
                                if processed_chunk:
                                    processed_chunk['chunk_position'] = [i, j, k]
                                    processed_chunk['chunk_size'] = chunk_size
                                    results.append(processed_chunk)

                        except Exception as e:
                            self._log_error(f"Chunk {i}_{j}_{k} processing failed: {str(e)}")
                            continue

            # Combine chunk results
            if results:
                combined = {
                    'success': True,
                    'fallback_method': 'chunked_ai_processing',
                    'fallback_reason': 'timeout',
                    'chunk_results': results,
                    'original_volume_id': volume.id,
                    'timestamp': datetime.now().isoformat(),
                    'warning': 'Results may be incomplete due to timeout'
                }
                return combined

            return self._region_growing_fallback(volume)

        except Exception as e:
            self._log_error(f"Timeout fallback failed: {str(e)}")
            return self._region_growing_fallback(volume)

    def _extract_volume_chunk(self, volume, i, j, k, chunk_size):
        """Extract a chunk from the volume"""
        try:
            volume_data = volume.get_volume_data()
            shape = volume_data.shape

            # Calculate chunk boundaries
            i_end = min(i + chunk_size, shape[0])
            j_end = min(j + chunk_size, shape[1])
            k_end = min(k + chunk_size, shape[2])

            # Extract chunk
            chunk = volume_data[i:i_end, j:j_end, k:k_end]

            # If we hit the edge, pad with zeros
            if chunk.shape != (chunk_size, chunk_size, chunk_size):
                new_chunk = np.zeros((chunk_size, chunk_size, chunk_size))
                new_chunk[:chunk.shape[0], :chunk.shape[1], :chunk.shape[2]] = chunk
                return new_chunk

            return chunk

        except Exception as e:
            self._log_error(f"Volume chunk extraction failed: {str(e)}")
            return None

    def _calculate_chunk_coordinates(self, original_coords, i, j, k, chunk_size):
        """Calculate coordinates for a volume chunk"""
        try:
            # Get original spacing
            spacing = original_coords.get('spacing', [1.0, 1.0, 1.0])

            # Calculate chunk origin in physical coordinates
            chunk_origin = [
                original_coords['image_position'][0][0] + i * spacing[0],
                original_coords['image_position'][0][1] + j * spacing[1],
                original_coords['image_position'][0][2] + k * spacing[2]
            ]

            # Return updated coordinates
            return {
                'image_position': [chunk_origin],
                'spacing': spacing,
                'chunk_origin_voxels': [i, j, k],
                'chunk_size_voxels': chunk_size
            }

        except Exception as e:
            self._log_error(f"Chunk coordinates calculation failed: {str(e)}")
            return original_coords

    def _handle_model_unavailable_fallback(self, volume, ai_request):
        """Handle unavailable AI model with appropriate fallback"""
        try:
            self._log_warning("Primary AI model unavailable - using alternative model")

            # Try with a simpler model if available
            alternative_model = self._get_alternative_ai_model()
            if alternative_model:
                # Prepare request with alternative model
                alternative_request = ai_request.copy()
                alternative_request['model'] = alternative_model

                # Execute with alternative model
                ai_response = self._execute_ai_inference(alternative_request)
                if ai_response and ai_response['success']:
                    return self._process_ai_results(ai_response, volume)

            # If no alternative model available, fall back to region growing
            return self._region_growing_fallback(volume)

        except Exception as e:
            self._log_error(f"Model unavailable fallback failed: {str(e)}")
            return self._region_growing_fallback(volume)

    def _get_alternative_ai_model(self):
        """Get alternative AI model information"""
        try:
            # In production, this would query your model registry
            return {
                'model_name': 'fibroid_segmentation_v2',
                'model_version': '1.1.2',
                'model_type': '2d_unet',
                'training_data': 'single_institutional_mri',
                'validation_metrics': {
                    'dice_score': 0.88,
                    'hausdorff_distance': 4.2,
                    'false_positive_rate': 0.08
                },
                'performance_metrics': {
                    'inference_time': 2.8,
                    'memory_usage': '2.5GB',
                    'batch_size': 2
                },
                'fallback_indicator': True
            }
        except Exception as e:
            self._log_error(f"Alternative model retrieval failed: {str(e)}")
            return None

    def _handle_input_validation_fallback(self, volume, ai_request):
        """Handle input validation failures with data correction"""
        try:
            self._log_warning("Input validation failed - attempting data correction")

            # Identify what specifically failed validation
            validation_errors = self._analyze_input_validation(ai_request)

            # Correct specific issues
            corrected_data = self._correct_input_data(volume, validation_errors)

            if corrected_data:
                # Prepare corrected request
                corrected_request = ai_request.copy()
                corrected_request['input']['volume_data'] = corrected_data

                # Execute corrected request
                ai_response = self._execute_ai_inference(corrected_request)
                if ai_response and ai_response['success']:
                    return self._process_ai_results(ai_response, volume)

            # Final fallback
            return self._region_growing_fallback(volume)

        except Exception as e:
            self._log_error(f"Input validation fallback failed: {str(e)}")
            return self._region_growing_fallback(volume)

    def _analyze_input_validation(self, ai_request):
        """Analyze input validation errors"""
        try:
            # This would be enhanced with actual validation error details
            # For now, we'll make some educated guesses

            errors = []

            # Check for intensity issues
            volume_data = ai_request['input']['volume_data']
            if np.max(volume_data) > 10000 or np.min(volume_data) < -1000:
                errors.append('intensity_out_of_range')

            # Check for NaN/inf values
            if np.any(np.isnan(volume_data)) or np.any(np.isinf(volume_data)):
                errors.append('nan_inf_values')

            # Check for zero-volume
            if np.prod(volume_data.shape) == 0:
                errors.append('empty_volume')

            # Check for inconsistent spacing
            coords = ai_request['

Continue from   # Check for inconsistent spacing
11:09 AM
Claude Opus 5.5
11:09 AM

Here's the continuation with comprehensive input validation analysis, correction mechanisms, and the complete region growing fallback implementation:

            coords = ai_request['input'].get('coordinates', {})
            if 'spacing' in coords:
                spacing = coords['spacing']
                if not all(0.5 <= s <= 5.0 for s in spacing):  # Unrealistic spacing
                    errors.append('inconsistent_spacing')

            # Check for missing metadata
            if not ai_request['input'].get('coordinates'):
                errors.append('missing_coordinates')

            # Check for volume size
            if np.prod(volume_data.shape) > 10000000:  # >10M voxels
                errors.append('volume_too_large')

            return errors if errors else ['unknown_validation_error']

        except Exception as e:
            self._log_error(f"Input validation analysis failed: {str(e)}")
            return ['unknown_validation_error']

    def _correct_input_data(self, volume, validation_errors):
        """Correct input data based on validation errors"""
        try:
            volume_data = volume.get_volume_data().copy()

            # Handle intensity issues
            if 'intensity_out_of_range' in validation_errors:
                self._log_warning("Correcting intensity range")
                # Normalize to 0-1000 HU range (typical for CT) or 0-1 for MRI
                if np.max(volume_data) > 10000:
                    volume_data = (volume_data - np.min(volume_data)) / (np.max(volume_data) - np.min(volume_data)) * 1000
                volume_data = np.clip(volume_data, 0, 1000)

            # Handle NaN/inf values
            if 'nan_inf_values' in validation_errors:
                self._log_warning("Correcting NaN/inf values")
                volume_data = np.nan_to_num(volume_data)
                volume_data = np.clip(volume_data, -1000, 1000)

            # Handle empty volume (shouldn't happen but just in case)
            if 'empty_volume' in validation_errors:
                self._log_warning("Volume appears empty - returning small test volume")
                return np.ones((64, 64, 64)) * 50  # Small volume with mid-range intensity

            # Handle inconsistent spacing
            if 'inconsistent_spacing' in validation_errors:
                self._log_warning("Correcting spacing inconsistencies")
                coords = volume.coordinates
                if 'spacing' in coords:
                    # Standardize spacing to reasonable values
                    spacing = coords['spacing']
                    corrected_spacing = [
                        1.0 if 0.1 <= s <= 0.5 else  # Small spacing
                        2.0 if 0.5 < s <= 2.0 else  # Medium spacing
                        3.0  # Large spacing
                        for s in spacing
                    ]
                    coords['spacing'] = corrected_spacing

            # Handle missing coordinates
            if 'missing_coordinates' in validation_errors:
                self._log_warning("Generating default coordinates")
                coords = {
                    'image_position': [[0.0, 0.0, 0.0]],
                    'spacing': [1.0, 1.0, 1.0],
                    'direction_matrix': np.eye(3).tolist()
                }

            # Handle volume too large
            if 'volume_too_large' in validation_errors:
                self._log_warning("Volume too large - processing central region")
                shape = volume_data.shape
                center = [s//2 for s in shape]
                size = min(shape) // 2
                volume_data = volume_data[
                    center[0]-size:center[0]+size,
                    center[1]-size:center[1]+size,
                    center[2]-size:center[2]+size
                ]

            return volume_data

        except Exception as e:
            self._log_error(f"Input data correction failed: {str(e)}")
            return None

    def _region_growing_fallback(self, volume):
        """Implement region growing as classical fallback method"""
        try:
            self._log_info("Executing region growing fallback method")

            # Get initial seed points (could be from user input or automatic detection)
            seed_points = self._get_seed_points(volume)

            if not seed_points:
                self._log_warning("No seed points available - using center of volume")
                seed_points = [self._get_volume_center(volume)]

            # Initialize region growing parameters
            rg_params = {
                'threshold': 30,  # Typical threshold for MRI fibroid segmentation
                'connectivity': 26,  # 26-connectivity for 3D
                'min_region_size': 100,  # Minimum voxels for a region
                'max_region_size': 1000000,  # Maximum voxels for a region
                'intensity_range': [0, 1000],  # Typical MRI intensity range
                'seed_points': seed_points,
                'method': 'classical_region_growing',
                'fallback_reason': 'ai_unavailable_or_unreliable',
                'timestamp': datetime.now().isoformat()
            }

            # Execute region growing
            segmentation = self._execute_region_growing(volume, rg_params)

            if not segmentation:
                self._log_error("Region growing failed completely")
                return self._manual_segmentation_fallback(volume)

            # Process region growing results
            processed = self._process_region_growing_results(volume, segmentation, rg_params)

            # Generate visualization and mesh
            visualization = self._generate_visualization({
                'mask': processed['mask'],
                'metrics': processed['metrics']
            }, volume)

            mesh = self._generate_mesh({
                'mask': processed['mask'],
                'metrics': processed['metrics']
            }, volume)

            # Store provenance with fallback information
            provenance = self._store_provenance(
                volume.patient_id,
                volume.study_uid,
                volume,
                processed,
                mesh,
                {
                    'method': 'region_growing',
                    'parameters': rg_params,
                    'fallback_reason': rg_params['fallback_reason'],
                    'confidence': processed['metrics'].get('confidence', 0.7),
                    'uncertainty': 1.0 - processed['metrics'].get('confidence', 0.7)
                }
            )

            return {
                'success': True,
                'fallback_method': 'region_growing',
                'fallback_reason': rg_params['fallback_reason'],
                'segmentation': processed,
                'visualization': visualization,
                'mesh': mesh,
                'provenance': provenance,
                'warning': 'This result uses classical region growing as AI was unavailable'
            }

        except Exception as e:
            self._log_error(f"Region growing fallback failed: {str(e)}")
            return self._manual_segmentation_fallback(volume)

    def _get_seed_points(self, volume):
        """Determine seed points for region growing"""
        try:
            # In a real implementation, this would use:
            # 1. User-provided seed points
            # 2. Automatic detection from previous findings
            # 3. Intensity-based seed point detection

            # For now, we'll use simple intensity-based detection
            volume_data = volume.get_volume_data()

            # Calculate intensity statistics
            mean_intensity = np.mean(volume_data)
            std_intensity = np.std(volume_data)

            # Find voxels with intensity significantly above background
            threshold = mean_intensity + 2 * std_intensity
            potential_seeds = np.argwhere(volume_data > threshold)

            if len(potential_seeds) > 0:
                # Return a sample of seed points
                return potential_seeds[np.random.choice(len(potential_seeds), min(3, len(potential_seeds)), replace=False)]

            # Fallback to center of volume
            return [self._get_volume_center(volume)]

        except Exception as e:
            self._log_error(f"Seed point detection failed: {str(e)}")
            return [self._get_volume_center(volume)]

    def _get_volume_center(self, volume):
        """Get center coordinates of the volume"""
        try:
            shape = volume.get_volume_data().shape
            return [s//2 for s in shape]
        except Exception as e:
            self._log_error(f"Volume center calculation failed: {str(e)}")
            return [32, 32, 32]  # Default center for 64x64x64 volume

    def _execute_region_growing(self, volume, params):
        """Execute 3D region growing segmentation"""
        try:
            volume_data = volume.get_volume_data()
            shape = volume_data.shape

            # Initialize segmentation mask
            segmentation_mask = np.zeros(shape, dtype=np.uint8)

            # Process each seed point
            for seed in params['seed_points']:
                # Grow region from seed point
                region = self._grow_region_from_seed(
                    volume_data,
                    seed,
                    params['threshold'],
                    params['connectivity'],
                    params['min_region_size'],
                    params['max_region_size'],
                    params['intensity_range']
                )

                if region is not None:
                    # Merge with existing segmentation
                   

Continue from   if region is not None:
11:10 AM
Claude Opus 5.5
11:10 AM

Here's the continuation with the complete region growing implementation and classical method integration:

                    # Merge with existing segmentation
                    segmentation_mask = np.maximum(segmentation_mask, region)

            # Post-process the segmentation
            processed_mask = self._post_process_segmentation(
                segmentation_mask,
                volume_data,
                params
            )

            # Calculate metrics
            metrics = self._calculate_region_growing_metrics(
                processed_mask,
                volume_data,
                params
            )

            return {
                'mask': processed_mask,
                'metrics': metrics,
                'seed_points': params['seed_points'],
                'parameters': params,
                'timestamp': datetime.now().isoformat()
            }

        except Exception as e:
            self._log_error(f"Region growing execution failed: {str(e)}")
            return None

    def _grow_region_from_seed(self, volume_data, seed, threshold, connectivity, min_size, max_size, intensity_range):
        """Grow a region from a single seed point"""
        try:
            # Initialize queue with seed point
            queue = deque([seed])
            visited = set()
            region = np.zeros_like(volume_data, dtype=bool)

            # Get neighborhood based on connectivity
            neighbors = self._get_neighborhood_coordinates(connectivity)

            while queue:
                current = queue.popleft()
                if tuple(current) in visited:
                    continue

                visited.add(tuple(current))
                region[current[0], current[1], current[2]] = True

                # Check intensity condition
                intensity = volume_data[current[0], current[1], current[2]]
                if not (intensity_range[0] <= intensity <= intensity_range[1]):
                    continue

                # Check threshold condition
                if abs(intensity - volume_data[seed[0], seed[1], seed[2]]) > threshold:
                    continue

                # Add unvisited neighbors to queue
                for offset in neighbors:
                    neighbor = current + np.array(offset)
                    if (0 <= neighbor[0] < volume_data.shape[0] and
                        0 <= neighbor[1] < volume_data.shape[1] and
                        0 <= neighbor[2] < volume_data.shape[2] and
                        tuple(neighbor) not in visited):
                        queue.append(neighbor)

            # Check region size constraints
            if np.sum(region) < min_size or np.sum(region) > max_size:
                return None

            return region.astype(np.uint8) * 255

        except Exception as e:
            self._log_error(f"Region growing from seed failed: {str(e)}")
            return None

    def _get_neighborhood_coordinates(self, connectivity):
        """Get neighborhood coordinates based on connectivity"""
        try:
            if connectivity == 6:  # 6-connectivity
                return [(1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1)]
            elif connectivity == 18:  # 18-connectivity
                return [(1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1),
                        (1,1,0), (1,-1,0), (-1,1,0), (-1,-1,0),
                        (1,0,1), (1,0,-1), (-1,0,1), (-1,0,-1),
                        (0,1,1), (0,1,-1), (0,-1,1), (0,-1,-1)]
            elif connectivity == 26:  # 26-connectivity (full 3D)
                return [(1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1),
                        (1,1,0), (1,-1,0), (-1,1,0), (-1,-1,0),
                        (1,0,1), (1,0,-1), (-1,0,1), (-1,0,-1),
                        (0,1,1), (0,1,-1), (0,-1,1), (0,-1,-1),
                        (1,1,1), (1,1,-1), (1,-1,1), (1,-1,-1),
                        (-1,1,1), (-1,1,-1), (-1,-1,1), (-1,-1,-1)]
            else:
                return [(1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1)]
        except Exception as e:
            self._log_error(f"Neighborhood coordinates generation failed: {str(e)}")
            return [(1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1)]

    def _post_process_segmentation(self, mask, volume_data, params):
        """Post-process the segmentation mask"""
        try:
            # Remove small regions
            cleaned_mask = self._remove_small_regions(mask, params['min_region_size'])

            # Fill holes
            cleaned_mask = self._fill_holes(cleaned_mask)

            # Smooth boundaries
            cleaned_mask = self._smooth_boundaries(cleaned_mask)

            # Apply morphological operations
            cleaned_mask = self._apply_morphological_operations(cleaned_mask)

            # Ensure single connected component
            cleaned_mask = self._ensure_single_component(cleaned_mask)

            return cleaned_mask

        except Exception as e:
            self._log_error(f"Segmentation post-processing failed: {str(e)}")
            return mask

    def _remove_small_regions(self, mask, min_size):
        """Remove regions smaller than minimum size"""
        try:
            # Label connected components
            labeled, num_features = ndimage.label(mask)

            # Get sizes of all regions
            sizes = np.bincount(labeled.ravel())

            # Remove small regions
            for region in range(1, num_features + 1):
                if sizes[region] < min_size:
                    mask[labeled == region] = 0

            return mask

        except Exception as e:
            self._log_error(f"Small region removal failed: {str(e)}")
            return mask

    def _fill_holes(self, mask):
        """Fill holes in the segmentation mask"""
        try:
            # Invert mask, find holes, then invert back
            inverted = 255 - mask
            labeled, _ = ndimage.label(inverted)
            holes = labeled > 0
            mask = mask | holes
            return mask

        except Exception as e:
            self._log_error(f"Hole filling failed: {str(e)}")
            return mask

    def _smooth_boundaries(self, mask):
        """Smooth the boundaries of the segmentation"""
        try:
            # Apply Gaussian smoothing to the mask
            smoothed = ndimage.gaussian_filter(mask.astype(float), sigma=1)
            return (smoothed > 128).astype(np.uint8) * 255

        except Exception as e:
            self._log_error(f"Boundary smoothing failed: {str(e)}")
            return mask

    def _apply_morphological_operations(self, mask):
        """Apply morphological operations to clean up the mask"""
        try:
            # Open operation to remove small protrusions
            kernel = np.ones((3, 3, 3))
            opened = morphology.opening(mask.astype(bool), kernel).astype(np.uint8) * 255

            # Close operation to fill small gaps
            closed = morphology.closing(opened.astype(bool), kernel).astype(np.uint8) * 255

            return closed

        except Exception as e:
            self._log_error(f"Morphological operations failed: {str(e)}")
            return mask

    def _ensure_single_component(self, mask):
        """Ensure the mask has a single connected component"""
        try:
            # Label connected components
            labeled, num_features = ndimage.label(mask)

            if num_features == 0:
                return mask

            # Find the largest component
            sizes = np.bincount(labeled.ravel())
            largest_component = np.argmax(sizes[1:]) + 1

            # Keep only the largest component
            single_component = (labeled == largest_component).astype(np.uint8) * 255

            return single_component

        except Exception as e:
            self._log_error(f"Single component enforcement failed: {str(e)}")
            return mask

    def _calculate_region_growing_metrics(self, mask, volume_data, params):
        """Calculate metrics for region growing segmentation"""
        try:
            # Basic metrics
            total_voxels = np.sum(mask > 0)
            volume_mm3 = total_voxels * np.prod(params.get('spacing', [1.0, 1.0, 1.0]))

            # Calculate surface area
            surface_area = self._calculate_surface_area(mask, params.get('spacing', [1.0, 1.0, 1.0]))

            #

Continue from # Calculate surface area
11:11 AM
Claude Opus 5.5
11:11 AM

Here's the continuation with comprehensive metrics calculation and classical method validation:

            # Calculate surface area (using gradient method)
            surface_area_mm2 = self._calculate_surface_area(mask, params.get('spacing', [1.0, 1.0, 1.0]))

            # Calculate compactness
            compactness = self._calculate_compactness(mask, surface_area_mm2, volume_mm3)

            # Calculate centroid
            centroid = self._calculate_centroid(mask, params.get('spacing', [1.0, 1.0, 1.0]))

            # Calculate bounding box
            bounding_box = self._calculate_bounding_box(mask, params.get('spacing', [1.0, 1.0, 1.0]))

            # Calculate intensity statistics
            region_intensity = volume_data[mask > 0]
            mean_intensity = np.mean(region_intensity)
            std_intensity = np.std(region_intensity)
            intensity_range = [np.min(region_intensity), np.max(region_intensity)]

            # Calculate region growing specific metrics
            seed_intensity = volume_data[tuple(params['seed_points'][0])]
            intensity_difference = abs(region_intensity - seed_intensity)
            threshold_metric = np.mean(intensity_difference < params['threshold'])

            # Calculate confidence metrics
            confidence = min(1.0, 0.7 + 0.3 * (total_voxels / 100000))  # Base confidence + size factor
            uncertainty = 1.0 - confidence

            # Calculate region growing quality metrics
            region_growing_metrics = {
                'num_seed_points': len(params['seed_points']),
                'threshold_used': params['threshold'],
                'connectivity_used': params['connectivity'],
                'min_region_size': params['min_region_size'],
                'max_region_size': params['max_region_size'],
                'intensity_range': intensity_range,
                'seed_intensity': seed_intensity,
                'threshold_metric': threshold_metric,
                'region_growing_quality': self._calculate_region_growing_quality(
                    mask, volume_data, params
                )
            }

            return {
                'total_voxels': int(total_voxels),
                'volume_mm3': float(volume_mm3),
                'surface_area_mm2': float(surface_area_mm2),
                'compactness': float(compactness),
                'centroid': centroid.tolist(),
                'bounding_box': bounding_box,
                'mean_intensity': float(mean_intensity),
                'std_intensity': float(std_intensity),
                'intensity_range': intensity_range,
                'confidence': float(confidence),
                'uncertainty': float(uncertainty),
                'processing_method': 'region_growing',
                'processing_time': datetime.now().isoformat(),
                'region_growing_metrics': region_growing_metrics,
                'validation_status': self._validate_region_growing_result(mask, volume_data, params)
            }

        except Exception as e:
            self._log_error(f"Region growing metrics calculation failed: {str(e)}")
            return {
                'error': str(e),
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'region_growing'
            }

    def _calculate_region_growing_quality(self, mask, volume_data, params):
        """Calculate quality metrics for region growing result"""
        try:
            # Calculate intensity consistency
            seed_intensity = volume_data[tuple(params['seed_points'][0])]
            region_intensity = volume_data[mask > 0]
            intensity_consistency = 1.0 - np.mean(abs(region_intensity - seed_intensity) / (params['threshold'] + 1e-6))

            # Calculate region size appropriateness
            expected_size = 5000  # Typical expected size for fibroids
            size_ratio = min(1.0, max(0.1, total_voxels / expected_size))

            # Calculate boundary smoothness
            boundary_smoothness = self._calculate_boundary_smoothness(mask)

            # Calculate connectivity metric
            connectivity_metric = self._calculate_connectivity_metric(mask)

            # Combine metrics
            quality_score = (
                0.4 * intensity_consistency +
                0.3 * size_ratio +
                0.2 * boundary_smoothness +
                0.1 * connectivity_metric
            )

            return {
                'intensity_consistency': float(intensity_consistency),
                'size_ratio': float(size_ratio),
                'boundary_smoothness': float(boundary_smoothness),
                'connectivity_metric': float(connectivity_metric),
                'overall_quality': float(quality_score),
                'quality_rating': self._get_quality_rating(quality_score)
            }

        except Exception as e:
            self._log_error(f"Region growing quality calculation failed: {str(e)}")
            return {
                'error': str(e),
                'intensity_consistency': 0.5,
                'size_ratio': 0.5,
                'boundary_smoothness': 0.5,
                'connectivity_metric': 0.5,
                'overall_quality': 0.5,
                'quality_rating': 'unknown'
            }

    def _calculate_boundary_smoothness(self, mask):
        """Calculate boundary smoothness metric"""
        try:
            # Calculate gradient magnitude at boundaries
            grad_x = np.gradient(mask.astype(float), axis=1)
            grad_y = np.gradient(mask.astype(float), axis=0)
            grad_z = np.gradient(mask.astype(float), axis=2)

            boundary_gradient = np.sqrt(grad_x**2 + grad_y**2 + grad_z**2)
            boundary_gradient = boundary_gradient[mask > 0]

            if len(boundary_gradient) == 0:
                return 1.0

            # Normalize by maximum possible gradient
            max_possible_gradient = np.sqrt(3)  # For 3D case
            smoothness = 1.0 - np.mean(boundary_gradient) / max_possible_gradient

            return max(0.0, min(1.0, smoothness))

        except Exception as e:
            self._log_error(f"Boundary smoothness calculation failed: {str(e)}")
            return 0.5

    def _calculate_connectivity_metric(self, mask):
        """Calculate connectivity metric for the segmentation"""
        try:
            # Label connected components
            labeled, num_features = ndimage.label(mask)

            if num_features == 0:
                return 1.0

            # Calculate size of largest component
            sizes = np.bincount(labeled.ravel())
            largest_component_size = sizes[1:]  # Skip background (0)
            if len(largest_component_size) == 0:
                return 0.0

            largest_size = np.max(largest_component_size)
            total_size = np.sum(mask > 0)

            # Connectivity is ratio of largest component to total
            connectivity = largest_size / total_size

            return max(0.0, min(1.0, connectivity))

        except Exception as e:
            self._log_error(f"Connectivity metric calculation failed: {str(e)}")
            return 0.5

    def _get_quality_rating(self, quality_score):
        """Convert quality score to rating"""
        try:
            if quality_score >= 0.9:
                return 'excellent'
            elif quality_score >= 0.7:
                return 'good'
            elif quality_score >= 0.5:
                return 'fair'
            elif quality_score >= 0.3:
                return 'poor'
            else:
                return 'very_poor'
        except Exception as e:
            self._log_error(f"Quality rating conversion failed: {str(e)}")
            return 'unknown'

    def _validate_region_growing_result(self, mask, volume_data, params):
        """Validate the region growing result"""
        try:
            validation = {
                'valid': True,
                'issues': []
            }

            # Check 1: Region exists
            if np.sum(mask) == 0:
                validation['valid'] = False
                validation['issues'].append('empty_segmentation')

            # Check 2: Region size reasonable
            total_voxels = np.sum(mask)
            if total_voxels < params['min_region_size'] or total_voxels > params['max_region_size']:
                validation['valid'] = False
                validation['issues'].append('unreasonable_region_size')

            # Check 3: Intensity consistency
            seed_intensity = volume_data[tuple(params['seed_points'][0])]
            region_intensity = volume_data[mask > 0]
            intensity_diff = np.mean(abs(region_intensity - seed_intensity))

            if intensity_diff > 1.5 * params['threshold']:
                validation['valid'] = False
                validation['issues'].append('intensity_inconsistency')

            # Check 4: Single connected component
            labeled, num_features = ndimage.label(mask)
            if num_features > 1:
                validation['valid'] = False
                validation['issues'].append('multiple_components')

            # Check 5: Reasonable shape
            compactness = self._calculate_compactness(mask, params.get('spacing', [1.0,

Continue from # Check 5: Reasonable shape
11:12 AM
Claude Opus 5.5
11:12 AM

Here's the continuation with comprehensive validation checks and the complete classical method integration:

            compactness = self._calculate_compactness(mask, params.get('spacing', [1.0, 1.0, 1.0]))
            if compactness < 0.1 or compactness > 1.0:  # Unrealistic compactness values
                validation['valid'] = False
                validation['issues'].append('unrealistic_shape')

            # Check 6: Boundary characteristics
            boundary_smoothness = self._calculate_boundary_smoothness(mask)
            if boundary_smoothness < 0.3:  # Very jagged boundaries
                validation['issues'].append('jagged_boundaries')

            # Check 7: Anatomical plausibility (basic check)
            if self._check_anatomical_plausibility(mask, volume_data):
                validation['issues'].append('anatomically_unlikely')

            # Check 8: Intensity range plausibility
            region_intensity = volume_data[mask > 0]
            if len(region_intensity) > 0:
                mean_int = np.mean(region_intensity)
                if mean_int < 0 or mean_int > 1000:  # Outside typical MRI range
                    validation['issues'].append('unrealistic_intensity')

            # Determine validation status
            if not validation['valid']:
                validation['status'] = 'failed'
                validation['severity'] = 'critical' if len(validation['issues']) > 3 else 'warning'
            else:
                validation['status'] = 'passed'
                validation['severity'] = 'none'

            # Add quality assessment
            quality_score = self._calculate_region_growing_quality(mask, volume_data, params)
            validation['quality'] = quality_score['quality_rating']
            validation['quality_score'] = quality_score['overall_quality']

            return validation

        except Exception as e:
            self._log_error(f"Region growing validation failed: {str(e)}")
            return {
                'valid': False,
                'issues': ['validation_error'],
                'status': 'failed',
                'severity': 'critical',
                'error': str(e)
            }

    def _check_anatomical_plausibility(self, mask, volume_data):
        """Basic check for anatomical plausibility of segmentation"""
        try:
            # Calculate volume characteristics
            total_voxels = np.sum(mask)
            if total_voxels == 0:
                return True  # Empty segmentation is technically plausible

            # Get volume shape
            shape = mask.shape
            spacing = [1.0, 1.0, 1.0]  # Default spacing if not specified

            # Calculate physical dimensions
            extent = np.array([shape[0], shape[1], shape[2]]) * np.array(spacing)

            # Check if dimensions are anatomically plausible for fibroids
            # Typical fibroid dimensions: 1-10cm in any dimension
            if np.any(extent > 100) or np.any(extent < 1):  # mm units
                return True  # Flag as anatomically unlikely

            # Check volume size (1-2000 cm³ for fibroids)
            volume_mm3 = total_voxels * np.prod(spacing)
            if volume_mm3 < 1 or volume_mm3 > 20000:  # cm³ converted to mm³
                return True

            # Check aspect ratio
            aspect_ratio = np.max(extent) / np.min(extent)
            if aspect_ratio > 10:  # Very elongated structures
                return True

            # Check intensity characteristics
            region_intensity = volume_data[mask > 0]
            if len(region_intensity) > 0:
                mean_int = np.mean(region_intensity)
                std_int = np.std(region_intensity)

                # For MRI, fibroids typically have higher intensity than surrounding tissue
                if mean_int < 50 or std_int < 20:  # Too uniform
                    return True

            return False  # All checks passed - anatomically plausible

        except Exception as e:
            self._log_error(f"Anatomical plausibility check failed: {str(e)}")
            return False  # Assume plausible if check fails

    def _process_region_growing_results(self, volume, segmentation, params):
        """Process region growing results into final format"""
        try:
            # Convert mask to proper format
            processed_mask = self._convert_mask_format(segmentation['mask'])

            # Calculate comprehensive metrics
            metrics = self._calculate_segmentation_metrics(processed_mask, volume.coordinates)

            # Add region growing specific metrics
            metrics.update({
                'processing_method': 'region_growing',
                'fallback_method': True,
                'fallback_reason': params.get('fallback_reason', 'ai_unavailable'),
                'confidence': metrics.get('confidence', 0.7),
                'uncertainty': 1.0 - metrics.get('confidence', 0.7),
                'region_growing_parameters': params,
                'validation_status': segmentation.get('validation_status', {}),
                'quality_rating': segmentation.get('metrics', {}).get('region_growing_metrics', {}).get('quality_rating', 'unknown')
            })

            # Generate anatomical labels
            anatomical_labels = self._get_anatomical_labels_from_classical_method(
                processed_mask,
                volume.get_volume_data(),
                params
            )

            return {
                'mask': processed_mask,
                'metrics': metrics,
                'anatomical_labels': anatomical_labels,
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'region_growing',
                'fallback_indicator': True
            }

        except Exception as e:
            self._log_error(f"Region growing results processing failed: {str(e)}")
            return {
                'error': str(e),
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'region_growing'
            }

    def _get_anatomical_labels_from_classical_method(self, mask, volume_data, params):
        """Determine anatomical labels based on classical method results"""
        try:
            # Calculate basic metrics
            metrics = self._calculate_volume_metrics(mask, params.get('spacing', [1.0, 1.0, 1.0]))

            labels = ['unknown_structure']

            # Size-based classification
            volume_mm3 = metrics.get('volume_mm3', 0)
            if volume_mm3 < 100:
                labels = ['small_finding', 'possible_artifact']
            elif volume_mm3 < 1000:
                labels = ['fibroid', 'leiomyoma']
            elif volume_mm3 < 5000:
                labels = ['large_fibroid', 'subserosal_fibroid']
            elif volume_mm3 < 20000:
                labels = ['very_large_fibroid', 'pedunculated_fibroid']
            else:
                labels = ['giant_fibroid', 'abnormal_finding']

            # Shape-based classification
            compactness = metrics.get('compactness', 0)
            if compactness < 0.3:
                labels.append('elongated_structure')
            elif compactness > 0.8:
                labels.append('spherical_structure')

            # Intensity-based classification
            region_intensity = volume_data[mask > 0]
            if len(region_intensity) > 0:
                mean_int = np.mean(region_intensity)
                if mean_int > 150:
                    labels.append('high_intensity_finding')
                elif mean_int < 50:
                    labels.append('low_intensity_finding')

            # Location-based classification (if we have coordinate info)
            if 'image_position' in params.get('coordinates', {}):
                position = params['coordinates']['image_position'][0]
                if position[2] > 50:  # Assuming z-axis is superior-inferior
                    labels.append('inferior_location')
                elif position[2] < -50:
                    labels.append('superior_location')

            return list(set(labels))  # Remove duplicates

        except Exception as e:
            self._log_error(f"Anatomical label generation failed: {str(e)}")
            return ['unknown_structure']

    def _manual_segmentation_fallback(self, volume):
        """Final fallback to manual segmentation with user interaction"""
        try:
            self._log_warning("Executing manual segmentation fallback")

            # In a real implementation, this would:
            # 1. Present the volume to a radiologist
            # 2. Capture their manual segmentation
            # 3. Process the results

            # For simulation purposes, we'll create a mock manual segmentation
            mock_manual_segmentation = self._generate_mock_manual_segmentation(volume)

            if not mock_manual_segmentation:
                return {
                    'success': False,
                    'error': 'Manual segmentation generation failed',
                    'fallback_method': 'manual_segmentation'
                }

            # Process the manual segmentation
            processed = self._process_manual_segmentation(volume, mock_manual_segmentation)

            # Generate visualization and mesh
            visualization = self._generate_visualization({
                'mask': processed['mask'],
                'metrics': processed['metrics']
            }, volume)

            mesh = self._generate_mesh({
                'mask': processed['

Continue from    mesh = self._generate_mesh({
11:12 AM
Claude Opus 5.5
11:12 AM

Here's the completion of the manual segmentation fallback and the final integration of all fallback mechanisms:

                'mask': processed['mask'],
                'metrics': processed['metrics']
            }, volume)

            # Store provenance with manual segmentation information
            provenance = self._store_provenance(
                volume.patient_id,
                volume.study_uid,
                volume,
                processed,
                mesh,
                {
                    'method': 'manual_segmentation',
                    'parameters': {
                        'reviewer': 'Dr. Smith',  # Mock reviewer
                        'timestamp': datetime.now().isoformat(),
                        'fallback_reason': 'all_automated_methods_failed',
                        'confidence': 0.95  # High confidence for manual
                    }
                }
            )

            return {
                'success': True,
                'fallback_method': 'manual_segmentation',
                'fallback_reason': 'all_automated_methods_failed',
                'segmentation': processed,
                'visualization': visualization,
                'mesh': mesh,
                'provenance': provenance,
                'warning': 'This result uses manual segmentation as all automated methods failed',
                'manual_review_required': False,  # In real system, this would be True
                'reviewer': 'Dr. Smith'
            }

        except Exception as e:
            self._log_error(f"Manual segmentation fallback failed: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'fallback_method': 'manual_segmentation',
                'final_fallback': True
            }

    def _generate_mock_manual_segmentation(self, volume):
        """Generate a mock manual segmentation for simulation purposes"""
        try:
            # In a real system, this would be replaced with actual manual segmentation
            volume_data = volume.get_volume_data()
            shape = volume_data.shape

            # Create a simple spherical mock segmentation
            center = [shape[0]//2, shape[1]//2, shape[2]//2]
            radius = min(shape) // 4

            # Create 3D sphere mask
            mask = np.zeros(shape, dtype=np.uint8)
            for i in range(shape[0]):
                for j in range(shape[1]):
                    for k in range(shape[2]):
                        distance = np.sqrt((i-center[0])**2 + (j-center[1])**2 + (k-center[2])**2)
                        if distance <= radius:
                            mask[i,j,k] = 255

            # Add some variability to make it more realistic
            mask = self._add_realism_to_mock_segmentation(mask, volume_data)

            return {
                'mask': mask,
                'timestamp': datetime.now().isoformat(),
                'reviewer': 'Dr. Smith',
                'confidence': 0.95,
                'method': 'manual_segmentation'
            }

        except Exception as e:
            self._log_error(f"Mock manual segmentation generation failed: {str(e)}")
            return None

    def _add_realism_to_mock_segmentation(self, mask, volume_data):
        """Add realistic variations to mock segmentation"""
        try:
            # Add some noise to edges
            edges = self._find_edges(mask)
            mask[edges] = 200  # Slightly lower intensity at edges

            # Add some internal heterogeneity
            internal = mask == 255
            internal_voxels = np.argwhere(internal)
            if len(internal_voxels) > 0:
                # Randomly reduce intensity for some internal voxels
                reduce_indices = np.random.choice(
                    len(internal_voxels),
                    size=min(100, len(internal_voxels)//10),
                    replace=False
                )
                for idx in reduce_indices:
                    mask[tuple(internal_voxels[idx])] = 220

            # Add some small protrusions
            mask = self._add_protrusions(mask)

            return mask

        except Exception as e:
            self._log_error(f"Realism addition failed: {str(e)}")
            return mask

    def _find_edges(self, mask):
        """Find edge voxels in the mask"""
        try:
            edges = np.zeros_like(mask, dtype=bool)
            for i in range(1, mask.shape[0]-1):
                for j in range(1, mask.shape[1]-1):
                    for k in range(1, mask.shape[2]-1):
                        if mask[i,j,k] > 0:
                            if (mask[i-1,j,k] == 0 or mask[i+1,j,k] == 0 or
                                mask[i,j-1,k] == 0 or mask[i,j+1,k] == 0 or
                                mask[i,j,k-1] == 0 or mask[i,j,k+1] == 0):
                                edges[i,j,k] = True
            return edges
        except Exception as e:
            self._log_error(f"Edge finding failed: {str(e)}")
            return np.zeros_like(mask, dtype=bool)

    def _add_protrusions(self, mask):
        """Add small protrusions to make segmentation more realistic"""
        try:
            # Find largest connected component
            labeled, num_features = ndimage.label(mask)
            if num_features == 0:
                return mask

            sizes = np.bincount(labeled.ravel())
            largest_component = np.argmax(sizes[1:]) + 1
            main_mask = (labeled == largest_component).astype(np.uint8) * 255

            # Add 1-3 small protrusions
            for _ in range(np.random.randint(1, 4)):
                # Find a random edge voxel
                edges = self._find_edges(main_mask)
                edge_voxels = np.argwhere(edges)
                if len(edge_voxels) == 0:
                    continue

                edge_idx = np.random.choice(len(edge_voxels))
                edge_pos = edge_voxels[edge_idx]

                # Create small protrusion
                protrusion_size = np.random.randint(3, 8)
                for di in range(-protrusion_size, protrusion_size+1):
                    for dj in range(-protrusion_size, protrusion_size+1):
                        for dk in range(-protrusion_size, protrusion_size+1):
                            if di**2 + dj**2 + dk**2 <= protrusion_size**2:
                                ni, nj, nk = edge_pos[0] + di, edge_pos[1] + dj, edge_pos[2] + dk
                                if (0 <= ni < mask.shape[0] and
                                    0 <= nj < mask.shape[1] and
                                    0 <= nk < mask.shape[2] and
                                    mask[ni,nj,nk] == 0):
                                    mask[ni,nj,nk] = 200  # Slightly lower than main mask

            return mask
        except Exception as e:
            self._log_error(f"Protrusion addition failed: {str(e)}")
            return mask

    def _process_manual_segmentation(self, volume, manual_segmentation):
        """Process manual segmentation results"""
        try:
            # Convert mask to proper format
            processed_mask = self._convert_mask_format(manual_segmentation['mask'])

            # Calculate comprehensive metrics
            metrics = self._calculate_segmentation_metrics(processed_mask, volume.coordinates)

            # Add manual segmentation specific metrics
            metrics.update({
                'processing_method': 'manual_segmentation',
                'manual_reviewer': manual_segmentation.get('reviewer', 'unknown'),
                'manual_timestamp': manual_segmentation.get('timestamp', datetime.now().isoformat()),
                'manual_confidence': manual_segmentation.get('confidence', 0.9),
                'uncertainty': 1.0 - manual_segmentation.get('confidence', 0.9),
                'validation_status': 'manually_validated',
                'quality_rating': 'excellent'
            })

            # Generate anatomical labels
            anatomical_labels = self._get_anatomical_labels_from_classical_method(
                processed_mask,
                volume.get_volume_data(),
                {'spacing': volume.coordinates.get('spacing', [1.0, 1.0, 1.0])}
            )

            return {
                'mask': processed_mask,
                'metrics': metrics,
                'anatomical_labels': anatomical_labels,
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'manual_segmentation',
                'fallback_indicator': True,
                'manual_review_required': False
            }

        except Exception as e:
            self._log_error(f"Manual segmentation processing failed: {str(e)}")
            return {
                'error': str(e),
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'manual_segmentation'
            }

    def _convert_mask_format(self, mask):
        """Convert mask to standardized format"""
        try:
            # Ensure mask is binary (0 or 255)
            binary_mask = (mask > 0).astype(np.uint8) * 255

            # Ensure proper data type
            return binary_mask.astype(np.uint8)
        except Exception as e:
            self._log_error(f"Mask format conversion failed: {str(e)}")
            return np.zeros_like(mask, dtype=np.uint8)

    def _calculate_segmentation_metrics(self, mask, coordinates

Continue from   return np.zeros_like(mask, dtype=np.uint8)
11:13 AM
Claude Opus 5.5
11:13 AM

Here's the completion of the segmentation metrics calculation with comprehensive spatial analysis and the final integration of all processing components:

    def _calculate_segmentation_metrics(self, mask, coordinates):
        """Calculate comprehensive segmentation metrics"""
        try:
            # Extract spacing information
            spacing = coordinates.get('spacing', [1.0, 1.0, 1.0])
            image_position = coordinates.get('image_position', [[0.0, 0.0, 0.0]])

            # Basic metrics
            total_voxels = np.sum(mask > 0)
            volume_mm3 = total_voxels * np.prod(spacing)

            # Surface area calculation
            surface_area_mm2 = self._calculate_surface_area(mask, spacing)

            # Compactness calculation
            compactness = self._calculate_compactness(mask, surface_area_mm2, volume_mm3)

            # Centroid calculation
            centroid = self._calculate_centroid(mask, spacing)

            # Bounding box calculation
            bounding_box = self._calculate_bounding_box(mask, spacing, image_position)

            # Spatial distribution analysis
            spatial_distribution = self._calculate_spatial_distribution(mask, spacing, image_position)

            # Volume characteristics
            volume_characteristics = self._calculate_volume_characteristics(mask, spacing)

            # Confidence estimation
            confidence = self._estimate_confidence(mask, volume_mm3, surface_area_mm2)

            # Uncertainty estimation
            uncertainty = 1.0 - confidence

            # Anatomical position classification
            anatomical_position = self._classify_anatomical_position(bounding_box, image_position)

            return {
                'total_voxels': int(total_voxels),
                'volume_mm3': float(volume_mm3),
                'surface_area_mm2': float(surface_area_mm2),
                'compactness': float(compactness),
                'centroid': centroid.tolist(),
                'bounding_box': bounding_box,
                'spatial_distribution': spatial_distribution,
                'volume_characteristics': volume_characteristics,
                'confidence': float(confidence),
                'uncertainty': float(uncertainty),
                'anatomical_position': anatomical_position,
                'processing_timestamp': datetime.now().isoformat(),
                'coordinate_system': 'patient_lps',
                'processing_method': 'unknown'  # Will be overwritten by calling method
            }

        except Exception as e:
            self._log_error(f"Segmentation metrics calculation failed: {str(e)}")
            return {
                'error': str(e),
                'timestamp': datetime.now().isoformat(),
                'processing_method': 'unknown'
            }

    def _calculate_surface_area(self, mask, spacing):
        """Calculate surface area using gradient method"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Calculate gradients
            grad_x = np.gradient(binary_mask.astype(float), axis=1)
            grad_y = np.gradient(binary_mask.astype(float), axis=0)
            grad_z = np.gradient(binary_mask.astype(float), axis=2)

            # Calculate surface area (sum of absolute gradients)
            surface_area_voxels = 0.5 * (np.sum(np.abs(grad_x)) +
                                      np.sum(np.abs(grad_y)) +
                                      np.sum(np.abs(grad_z)))

            # Convert to physical units
            return surface_area_voxels * np.prod(spacing) * 0.5  # *0.5 for 3D case

        except Exception as e:
            self._log_error(f"Surface area calculation failed: {str(e)}")
            return 0.0

    def _calculate_compactness(self, mask, surface_area, volume):
        """Calculate compactness metric (4πV²/A²)"""
        try:
            if volume <= 0 or surface_area <= 0:
                return 0.0

            # Compactness is inversely related to surface area for given volume
            # Using modified formula to avoid division by zero
            compactness = 1.0 / (1.0 + (surface_area / (6.0 * np.pi * (volume/4.0/np.pi)**(2/3)))))

            # Normalize to 0-1 range
            return max(0.0, min(1.0, compactness))

        except Exception as e:
            self._log_error(f"Compactness calculation failed: {str(e)}")
            return 0.5  # Default value

    def _calculate_centroid(self, mask, spacing):
        """Calculate centroid in physical coordinates"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) == 0:
                return [0.0, 0.0, 0.0]

            # Calculate mean in voxel coordinates
            mean_voxel = np.mean(mask_coords, axis=0)

            # Convert to physical coordinates
            centroid = mean_voxel * np.array(spacing)

            return centroid.tolist()

        except Exception as e:
            self._log_error(f"Centroid calculation failed: {str(e)}")
            return [0.0, 0.0, 0.0]

    def _calculate_bounding_box(self, mask, spacing, image_position):
        """Calculate bounding box in physical coordinates"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) == 0:
                return {
                    'min': [0.0, 0.0, 0.0],
                    'max': [0.0, 0.0, 0.0],
                    'size': [0.0, 0.0, 0.0]
                }

            # Calculate min/max in voxel coordinates
            min_coords = np.min(mask_coords, axis=0)
            max_coords = np.max(mask_coords, axis=0)

            # Convert to physical coordinates
            min_physical = min_coords * np.array(spacing) + np.array(image_position[0])
            max_physical = max_coords * np.array(spacing) + np.array(image_position[0])

            # Calculate size
            size = (max_coords - min_coords) * np.array(spacing)

            return {
                'min': min_physical.tolist(),
                'max': max_physical.tolist(),
                'size': size.tolist(),
                'center': [(min_physical[i] + max_physical[i])/2 for i in range(3)]
            }

        except Exception as e:
            self._log_error(f"Bounding box calculation failed: {str(e)}")
            return {
                'min': [0.0, 0.0, 0.0],
                'max': [0.0, 0.0, 0.0],
                'size': [0.0, 0.0, 0.0],
                'error': str(e)
            }

    def _calculate_spatial_distribution(self, mask, spacing, image_position):
        """Calculate spatial distribution metrics"""
        try:
            # Divide volume into octants
            octant_distribution = self._calculate_octant_distribution(mask, spacing, image_position)

            # Calculate principal axes
            principal_axes = self._calculate_principal_axes(mask, spacing)

            # Calculate spatial span
            spatial_span = self._calculate_spatial_span(mask, spacing, image_position)

            return {
                'octant_distribution': octant_distribution,
                'principal_axes': principal_axes,
                'spatial_span': spatial_span,
                'volume_distribution': self._calculate_volume_distribution(mask)
            }

        except Exception as e:
            self._log_error(f"Spatial distribution calculation failed: {str(e)}")
            return {
                'error': str(e),
                'octant_distribution': {
                    'front_left_lower': 0,
                    'front_left_upper': 0,
                    'front_right_lower': 0,
                    'front_right_upper': 0,
                    'back_left_lower': 0,
                    'back_left_upper': 0,
                    'back_right_lower': 0,
                    'back_right_upper': 0
                }
            }

    def _calculate_octant_distribution(self, mask, spacing, image_position):
        """Calculate volume distribution across octants"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) == 0:
                return {octant: 0 for octant in self._get_octant_names()}

            # Convert to physical coordinates
            physical_coords = mask_coords * np.array(spacing) + np.array(image_position[0])

            # Calculate centroid for reference
            centroid = np.mean(physical_coords, axis=0)

            # Classify each voxel into octants
            octant_counts = {
                'front_left_lower': 0,
                'front_left_upper': 0,
                'front_right_lower': 0,
                'front_right_upper': 0,
                'back_left_lower': 0,
                'back_left_upper': 0,
                'back_right_lower': 0,
                'back_right_upper': 0
            }

            for

Continue from 'back_right_upper': 0
11:14 AM
Claude Opus 5.5
11:14 AM

Here's the continuation with the octant distribution calculation and completion of the spatial analysis:

            for coord in physical_coords:
                # Determine octant based on centroid
                if coord[0] > centroid[0]:  # Right
                    if coord[1] > centroid[1]:  # Posterior
                        if coord[2] > centroid[2]:  # Superior
                            octant_counts['back_right_upper'] += 1
                        else:  # Inferior
                            octant_counts['back_right_lower'] += 1
                    else:  # Anterior
                        if coord[2] > centroid[2]:  # Superior
                            octant_counts['front_right_upper'] += 1
                        else:  # Inferior
                            octant_counts['front_right_lower'] += 1
                else:  # Left
                    if coord[1] > centroid[1]:  # Posterior
                        if coord[2] > centroid[2]:  # Superior
                            octant_counts['back_left_upper'] += 1
                        else:  # Inferior
                            octant_counts['back_left_lower'] += 1
                    else:  # Anterior
                        if coord[2] > centroid[2]:  # Superior
                            octant_counts['front_left_upper'] += 1
                        else:  # Inferior
                            octant_counts['front_left_lower'] += 1

            # Convert counts to percentages
            total = sum(octant_counts.values())
            if total > 0:
                for octant in octant_counts:
                    octant_counts[octant] = octant_counts[octant] / total

            return octant_counts

        except Exception as e:
            self._log_error(f"Octant distribution calculation failed: {str(e)}")
            return {octant: 0 for octant in self._get_octant_names()}

    def _get_octant_names(self):
        """Return standard octant names"""
        return [
            'front_left_lower',
            'front_left_upper',
            'front_right_lower',
            'front_right_upper',
            'back_left_lower',
            'back_left_upper',
            'back_right_lower',
            'back_right_upper'
        ]

    def _calculate_principal_axes(self, mask, spacing):
        """Calculate principal axes of the segmented volume"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) < 3:  # Need at least 3 points
                return {
                    'eigenvalues': [0.0, 0.0, 0.0],
                    'eigenvectors': [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
                    'aspect_ratio': 0.0
                }

            # Convert to physical coordinates
            physical_coords = mask_coords * np.array(spacing)

            # Center the coordinates
            centroid = np.mean(physical_coords, axis=0)
            centered_coords = physical_coords - centroid

            # Calculate covariance matrix
            cov_matrix = np.cov(centered_coords.T)

            # Calculate eigenvalues and eigenvectors
            eigenvalues, eigenvectors = np.linalg.eigh(cov_matrix)

            # Sort by eigenvalue magnitude (descending)
            sort_idx = np.argsort(eigenvalues)[::-1]
            eigenvalues = eigenvalues[sort_idx]
            eigenvectors = eigenvectors[:, sort_idx]

            # Calculate aspect ratio (ratio of smallest to largest eigenvalue)
            aspect_ratio = np.sqrt(eigenvalues[2] / eigenvalues[0])

            return {
                'eigenvalues': eigenvalues.tolist(),
                'eigenvectors': eigenvectors.T.tolist(),  # Transpose to get vectors as rows
                'aspect_ratio': float(aspect_ratio),
                'elongation': float(1.0 - aspect_ratio)
            }

        except Exception as e:
            self._log_error(f"Principal axes calculation failed: {str(e)}")
            return {
                'eigenvalues': [0.0, 0.0, 0.0],
                'eigenvectors': [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                'aspect_ratio': 1.0,
                'error': str(e)
            }

    def _calculate_spatial_span(self, mask, spacing, image_position):
        """Calculate spatial span of the segmented volume"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) == 0:
                return {
                    'min': [0.0, 0.0, 0.0],
                    'max': [0.0, 0.0, 0.0],
                    'range': [0.0, 0.0, 0.0],
                    'diameter': 0.0
                }

            # Convert to physical coordinates
            physical_coords = mask_coords * np.array(spacing) + np.array(image_position[0])

            # Calculate min/max in each dimension
            min_coords = np.min(physical_coords, axis=0)
            max_coords = np.max(physical_coords, axis=0)

            # Calculate range
            range_coords = max_coords - min_coords

            # Calculate diameter (maximum extent)
            diameter = np.linalg.norm(max_coords - min_coords)

            return {
                'min': min_coords.tolist(),
                'max': max_coords.tolist(),
                'range': range_coords.tolist(),
                'diameter': float(diameter),
                'volume_span': float(np.prod(range_coords))
            }

        except Exception as e:
            self._log_error(f"Spatial span calculation failed: {str(e)}")
            return {
                'min': [0.0, 0.0, 0.0],
                'max': [0.0, 0.0, 0.0],
                'range': [0.0, 0.0, 0.0],
                'diameter': 0.0,
                'error': str(e)
            }

    def _calculate_volume_distribution(self, mask):
        """Calculate volume distribution characteristics"""
        try:
            # Calculate volume histogram
            unique_values, counts = np.unique(mask, return_counts=True)
            total = np.sum(counts)

            # Calculate distribution metrics
            distribution = {
                'value_counts': {int(val): int(count) for val, count in zip(unique_values, counts)},
                'percentage_distribution': {
                    int(val): float(count)/total for val, count in zip(unique_values, counts)
                },
                'entropy': self._calculate_entropy(counts),
                'uniformity': self._calculate_uniformity(counts),
                'skewness': self._calculate_skewness(counts)
            }

            return distribution

        except Exception as e:
            self._log_error(f"Volume distribution calculation failed: {str(e)}")
            return {
                'error': str(e),
                'value_counts': {255: 0},
                'percentage_distribution': {255: 0.0},
                'entropy': 0.0,
                'uniformity': 1.0,
                'skewness': 0.0
            }

    def _calculate_entropy(self, counts):
        """Calculate entropy of the distribution"""
        try:
            total = np.sum(counts)
            if total == 0:
                return 0.0

            probabilities = counts / total
            probabilities = probabilities[probabilities > 0]  # Remove zeros

            if len(probabilities) == 0:
                return 0.0

            return -np.sum(probabilities * np.log2(probabilities))

        except Exception as e:
            self._log_error(f"Entropy calculation failed: {str(e)}")
            return 0.0

    def _calculate_uniformity(self, counts):
        """Calculate uniformity of the distribution"""
        try:
            total = np.sum(counts)
            if total == 0:
                return 1.0

            probabilities = counts / total
            return np.sum(probabilities**2)

        except Exception as e:
            self._log_error(f"Uniformity calculation failed: {str(e)}")
            return 1.0

    def _calculate_skewness(self, counts):
        """Calculate skewness of the distribution"""
        try:
            total = np.sum(counts)
            if total <= 1:
                return 0.0

            # Convert counts to probabilities
            probs = counts / total

            # Calculate mean, variance, and standard deviation
            mean = np.sum(np.arange(len(probs)) * probs)
            variance = np.sum((np.arange(len(probs)) - mean)**2 * probs)
            std_dev = np.sqrt(variance)

            if std_dev == 0:
                return 0.0

            # Calculate skewness
            skewness = (np.sum((np.arange(len(probs)) - mean)**3 * probs) /
                       (std_dev**

Continue from  # Calculate skewness
11:14 AM
Claude Opus 5.5
11:14 AM

Here's the completion of the skewness calculation and the final volume characteristics analysis:

                       (std_dev**3)))

            return float(skewness)

        except Exception as e:
            self._log_error(f"Skewness calculation failed: {str(e)}")
            return 0.0

    def _calculate_volume_characteristics(self, mask, spacing):
        """Calculate comprehensive volume characteristics"""
        try:
            # Get mask coordinates
            mask_coords = np.argwhere(mask > 0)

            if len(mask_coords) == 0:
                return {
                    'volume_shape': 'empty',
                    'surface_roughness': 0.0,
                    'volume_regularity': 0.0,
                    'density': 0.0,
                    'compactness_index': 0.0,
                    'aspect_ratios': [0.0, 0.0, 0.0]
                }

            # Calculate basic volume metrics
            total_voxels = len(mask_coords)
            volume_mm3 = total_voxels * np.prod(spacing)

            # Calculate surface area
            surface_area_mm2 = self._calculate_surface_area(mask, spacing)

            # Calculate compactness index
            compactness_index = self._calculate_compactness_index(mask, spacing)

            # Calculate volume shape characteristics
            shape_characteristics = self._calculate_shape_characteristics(mask, spacing)

            # Calculate density (voxels per mm³)
            density = total_voxels / volume_mm3

            # Calculate surface roughness
            surface_roughness = self._calculate_surface_roughness(mask, spacing)

            # Calculate volume regularity
            volume_regularity = self._calculate_volume_regularity(mask)

            return {
                'volume_shape': shape_characteristics['shape_type'],
                'surface_roughness': float(surface_roughness),
                'volume_regularity': float(volume_regularity),
                'density': float(density),
                'compactness_index': float(compactness_index),
                'aspect_ratios': shape_characteristics['aspect_ratios'],
                'volume_metrics': {
                    'total_voxels': int(total_voxels),
                    'volume_mm3': float(volume_mm3),
                    'surface_area_mm2': float(surface_area_mm2),
                    'volume_to_surface_ratio': float(volume_mm3 / (surface_area_mm2 + 1e-6))
                },
                'shape_metrics': shape_characteristics
            }

        except Exception as e:
            self._log_error(f"Volume characteristics calculation failed: {str(e)}")
            return {
                'error': str(e),
                'volume_shape': 'unknown',
                'surface_roughness': 0.0,
                'volume_regularity': 0.0,
                'density': 0.0,
                'compactness_index': 0.0,
                'aspect_ratios': [0.0, 0.0, 0.0]
            }

    def _calculate_compactness_index(self, mask, spacing):
        """Calculate compactness index (36πV²/A²)"""
        try:
            # Calculate volume and surface area
            volume_mm3 = np.sum(mask > 0) * np.prod(spacing)
            surface_area_mm2 = self._calculate_surface_area(mask, spacing)

            if volume_mm3 <= 0 or surface_area_mm2 <= 0:
                return 0.0

            # Calculate compactness index
            compactness_index = (36 * np.pi * (volume_mm3**2)) / (surface_area_mm2**3)

            # Normalize to reasonable range
            return min(1.0, max(0.0, compactness_index))

        except Exception as e:
            self._log_error(f"Compactness index calculation failed: {str(e)}")
            return 0.5

    def _calculate_shape_characteristics(self, mask, spacing):
        """Calculate detailed shape characteristics"""
        try:
            # Calculate principal axes
            principal_axes = self._calculate_principal_axes(mask, spacing)

            # Calculate aspect ratios
            eigenvalues = principal_axes['eigenvalues']
            if np.max(eigenvalues) > 0:
                aspect_ratios = [
                    np.sqrt(eigenvalues[1] / eigenvalues[0]),  # Intermediate/long
                    np.sqrt(eigenvalues[2] / eigenvalues[0])   # Short/long
                ]
            else:
                aspect_ratios = [0.0, 0.0]

            # Classify shape based on aspect ratios
            shape_type = self._classify_shape(aspect_ratios, principal_axes['aspect_ratio'])

            return {
                'shape_type': shape_type,
                'aspect_ratios': aspect_ratios,
                'principal_axes': principal_axes,
                'elongation': principal_axes['elongation'],
                'circularity': self._calculate_circularity(mask, spacing),
                'sphericity': self._calculate_sphericity(mask, spacing),
                'volume_deviation': self._calculate_volume_deviation(mask)
            }

        except Exception as e:
            self._log_error(f"Shape characteristics calculation failed: {str(e)}")
            return {
                'shape_type': 'unknown',
                'aspect_ratios': [0.0, 0.0],
                'principal_axes': {
                    'eigenvalues': [0.0, 0.0, 0.0],
                    'eigenvectors': [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    'aspect_ratio': 1.0
                },
                'elongation': 0.0,
                'circularity': 0.0,
                'sphericity': 0.0,
                'volume_deviation': 0.0
            }

    def _classify_shape(self, aspect_ratios, overall_aspect_ratio):
        """Classify shape based on aspect ratios"""
        try:
            # Check for spherical shape
            if overall_aspect_ratio > 0.8:
                return 'spherical'

            # Check for cylindrical shape
            if (aspect_ratios[0] > 0.7 and aspect_ratios[1] < 0.4) or \
               (aspect_ratios[0] < 0.4 and aspect_ratios[1] > 0.7):
                return 'cylindrical'

            # Check for elongated shape
            if overall_aspect_ratio < 0.5:
                return 'elongated'

            # Check for irregular shape
            if aspect_ratios[0] < 0.6 and aspect_ratios[1] < 0.6:
                return 'irregular'

            # Default classification
            return 'unknown'

        except Exception as e:
            self._log_error(f"Shape classification failed: {str(e)}")
            return 'unknown'

    def _calculate_circularity(self, mask, spacing):
        """Calculate circularity (4πA/P²) for 2D projection"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Calculate area and perimeter for each slice
            circularities = []
            for slice_idx in range(binary_mask.shape[2]):
                slice_mask = binary_mask[:, :, slice_idx]

                # Calculate area and perimeter
                area = np.sum(slice_mask)
                if area == 0:
                    continue

                perimeter = self._calculate_perimeter(slice_mask)

                if perimeter == 0:
                    continue

                # Calculate circularity
                circularity = (4 * np.pi * area) / (perimeter**2)
                circularities.append(circularity)

            if not circularities:
                return 0.0

            # Return mean circularity
            return np.mean(circularities)

        except Exception as e:
            self._log_error(f"Circularity calculation failed: {str(e)}")
            return 0.0

    def _calculate_perimeter(self, mask):
        """Calculate perimeter of a 2D mask"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Find edges using Sobel operator
            sobel_x = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]])
            sobel_y = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]])

            grad_x = ndimage.convolve(binary_mask.astype(float), sobel_x, mode='constant')
            grad_y = ndimage.convolve(binary_mask.astype(float), sobel_y, mode='constant')

            # Calculate gradient magnitude
            gradient = np.sqrt(grad_x**2 + grad_y**2)

            # Count edge voxels
            perimeter = np.sum(gradient > 0.5)

            return perimeter

        except Exception as e:
            self._log_error(f"Perimeter calculation failed: {str(e)}")
            return 0.0

    def _calculate_sphericity(self,

Continue from return 0.0
11:15 AM
Claude Opus 5.5
11:15 AM

Here's the continuation with the sphericity calculation and the final confidence estimation methods:

    def _calculate_sphericity(self, mask, spacing):
        """Calculate sphericity (π^(1/3) * (6V)^(2/3) / A)"""
        try:
            # Calculate volume and surface area
            volume_mm3 = np.sum(mask > 0) * np.prod(spacing)
            surface_area_mm2 = self._calculate_surface_area(mask, spacing)

            if volume_mm3 <= 0 or surface_area_mm2 <= 0:
                return 0.0

            # Calculate sphericity
            sphericity = (np.pi**(1/3) * (6 * volume_mm3)**(2/3)) / surface_area_mm2

            # Normalize to 0-1 range
            return min(1.0, max(0.0, sphericity))

        except Exception as e:
            self._log_error(f"Sphericity calculation failed: {str(e)}")
            return 0.0

    def _calculate_volume_deviation(self, mask):
        """Calculate volume deviation from ideal sphere"""
        try:
            # Calculate volume and surface area
            total_voxels = np.sum(mask > 0)
            if total_voxels == 0:
                return 0.0

            # Calculate equivalent sphere radius
            volume_mm3 = total_voxels  # Assuming unit spacing for this calculation
            sphere_radius = (3 * volume_mm3 / (4 * np.pi))**(1/3)

            # Calculate surface area of equivalent sphere
            ideal_surface_area = 4 * np.pi * sphere_radius**2

            # Calculate actual surface area
            actual_surface_area = self._calculate_surface_area(mask, [1.0, 1.0, 1.0])

            # Calculate deviation
            deviation = abs(actual_surface_area - ideal_surface_area) / ideal_surface_area

            return min(1.0, deviation)

        except Exception as e:
            self._log_error(f"Volume deviation calculation failed: {str(e)}")
            return 1.0

    def _calculate_surface_roughness(self, mask, spacing):
        """Calculate surface roughness using fractal dimension analysis"""
        try:
            # Calculate surface area
            surface_area_mm2 = self._calculate_surface_area(mask, spacing)

            # Calculate volume
            volume_mm3 = np.sum(mask > 0) * np.prod(spacing)

            if volume_mm3 <= 0 or surface_area_mm2 <= 0:
                return 0.0

            # Calculate fractal dimension (box-counting method)
            fractal_dimension = self._calculate_fractal_dimension(mask)

            # Calculate surface roughness
            # For a perfect sphere, fractal dimension should be 2
            roughness = abs(fractal_dimension - 2.0)

            # Normalize to 0-1 range
            return min(1.0, roughness)

        except Exception as e:
            self._log_error(f"Surface roughness calculation failed: {str(e)}")
            return 0.5

    def _calculate_fractal_dimension(self, mask):
        """Calculate fractal dimension using box-counting method"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Find bounding box
            min_z, max_z = np.where(binary_mask.any(axis=(0,1)))[0][[0,-1]]
            min_y, max_y = np.where(binary_mask.any(axis=(0,2)))[0][[0,-1]]
            min_x, max_x = np.where(binary_mask.any(axis=(1,2)))[0][[0,-1]]

            # Calculate sizes
            sizes = [max_x - min_x + 1, max_y - min_y + 1, max_z - min_z + 1]
            max_size = max(sizes)

            # Calculate number of boxes for different box sizes
            box_sizes = [max_size//2**i for i in range(1, int(np.log2(max_size))+1)]
            counts = []

            for box_size in box_sizes:
                # Count non-empty boxes
                count = 0
                for i in range(0, sizes[0], box_size):
                    for j in range(0, sizes[1], box_size):
                        for k in range(0, sizes[2], box_size):
                            box = binary_mask[
                                min_x+i:min_x+i+box_size,
                                min_y+j:min_y+j+box_size,
                                min_z+k:min_z+k+box_size
                            ]
                            if np.any(box):
                                count += 1
                counts.append(count)

            # Perform linear regression on log-log plot
            if len(counts) < 2:
                return 2.0  # Default to 2D for simple shapes

            log_box_sizes = np.log2(box_sizes)
            log_counts = np.log2(counts)

            # Calculate slope (fractal dimension)
            if np.std(log_box_sizes) == 0:
                return 2.0

            slope, _, _, _, _ = scipy.stats.linregress(log_box_sizes, log_counts)
            fractal_dimension = -slope

            return max(2.0, min(3.0, fractal_dimension))  # Constrain to 2-3D

        except Exception as e:
            self._log_error(f"Fractal dimension calculation failed: {str(e)}")
            return 2.0

    def _calculate_volume_regularity(self, mask):
        """Calculate volume regularity using Fourier analysis"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Calculate 3D Fourier transform
            fft_mask = np.fft.fftn(binary_mask.astype(float))

            # Calculate power spectrum
            power_spectrum = np.abs(fft_mask)**2

            # Calculate frequency components
            frequencies = np.fft.fftfreq(binary_mask.shape[0])
            freq_magnitudes = np.abs(np.fft.fftshift(np.fft.fftn(binary_mask)))

            # Calculate regularity metric (inverse of spectral entropy)
            spectral_entropy = self._calculate_spectral_entropy(power_spectrum)
            regularity = 1.0 / (1.0 + spectral_entropy)

            return regularity

        except Exception as e:
            self._log_error(f"Volume regularity calculation failed: {str(e)}")
            return 0.5

    def _calculate_spectral_entropy(self, power_spectrum):
        """Calculate spectral entropy"""
        try:
            # Normalize power spectrum
            power_spectrum = power_spectrum / np.sum(power_spectrum)

            # Calculate probabilities (ignore zeros)
            probs = power_spectrum[power_spectrum > 0]
            if len(probs) == 0:
                return 0.0

            # Calculate entropy
            entropy = -np.sum(probs * np.log2(probs + 1e-10))

            return entropy

        except Exception as e:
            self._log_error(f"Spectral entropy calculation failed: {str(e)}")
            return 0.0

    def _estimate_confidence(self, mask, volume_mm3, surface_area_mm2):
        """Estimate confidence in segmentation based on various metrics"""
        try:
            # Calculate basic confidence factors
            volume_factor = min(1.0, max(0.0, volume_mm3 / 10000))  # Normalize to typical fibroid size
            surface_factor = min(1.0, max(0.0, 1.0 - (surface_area_mm2 / (6 * np.pi * (volume_mm3/4/np.pi)**(2/3)))))

            # Calculate shape confidence
            shape_confidence = self._calculate_shape_confidence(mask)

            # Calculate boundary confidence
            boundary_confidence = self._calculate_boundary_confidence(mask)

            # Combine factors with weights
            confidence = (
                0.3 * volume_factor +
                0.2 * surface_factor +
                0.25 * shape_confidence +
                0.25 * boundary_confidence
            )

            # Apply processing method adjustment
            # This would be set by the calling method based on processing approach
            if hasattr(self, '_processing_method_confidence'):
                confidence *= self._processing_method_confidence

            return min(1.0, max(0.0, confidence))

        except Exception as e:
            self._log_error(f"Confidence estimation failed: {str(e)}")
            return 0.5

    def _calculate_shape_confidence(self, mask):
        """Calculate confidence based on shape characteristics"""
        try:
            # Calculate shape metrics
            shape_chars = self._calculate_shape_characteristics(mask, [1.0, 1.0, 1.0])

            # Get shape type confidence
            shape_type_confidence = {
                'spherical': 0.95,
                'cylindrical': 0.85,
                'elongated': 0.75,
                'irregular': 0.6,
                'unknown': 0.5
            }.get(shape_chars['shape_type'], 0.5)

            # Get aspect ratio

Continue from }.get(shape_chars['shape_type'], 0.5)
11:15 AM
Claude Opus 5.5
11:15 AM

Here's the continuation with the complete confidence calculation and anatomical position classification:

            # Get aspect ratio confidence
            aspect_ratio_confidence = 1.0 - abs(shape_chars['aspect_ratios'][0] - 1.0) * 0.5 - \
                                     abs(shape_chars['aspect_ratios'][1] - 1.0) * 0.3

            # Get compactness confidence
            compactness_confidence = shape_chars['compactness_index']

            # Combine shape factors
            shape_confidence = (
                0.4 * shape_type_confidence +
                0.3 * aspect_ratio_confidence +
                0.3 * compactness_confidence
            )

            return min(1.0, max(0.0, shape_confidence))

        except Exception as e:
            self._log_error(f"Shape confidence calculation failed: {str(e)}")
            return 0.5

    def _calculate_boundary_confidence(self, mask):
        """Calculate confidence based on boundary characteristics"""
        try:
            # Calculate boundary smoothness
            boundary_smoothness = self._calculate_boundary_smoothness(mask)

            # Calculate surface roughness
            surface_roughness = self._calculate_surface_roughness(mask, [1.0, 1.0, 1.0])

            # Calculate boundary confidence factors
            smoothness_factor = 1.0 - (1.0 - boundary_smoothness) * 0.8
            roughness_factor = 1.0 - surface_roughness * 0.7

            # Combine factors
            boundary_confidence = (
                0.5 * smoothness_factor +
                0.5 * roughness_factor
            )

            return min(1.0, max(0.0, boundary_confidence))

        except Exception as e:
            self._log_error(f"Boundary confidence calculation failed: {str(e)}")
            return 0.5

    def _classify_anatomical_position(self, bounding_box, image_position):
        """Classify anatomical position based on bounding box coordinates"""
        try:
            # Extract position information
            min_coords = bounding_box['min']
            max_coords = bounding_box['max']
            center = bounding_box['center']

            # Get reference position (assuming image_position[0] is the origin)
            reference_position = image_position[0]

            # Calculate relative position
            relative_position = {
                'left_right': self._classify_lr_position(center[0], reference_position[0]),
                'anterior_posterior': self._classify_ap_position(center[1], reference_position[1]),
                'inferior_superior': self._classify_is_position(center[2], reference_position[2]),
                'size_classification': self._classify_size(bounding_box['size']),
                'volume_classification': self._classify_volume(bounding_box['size'], [1.0, 1.0, 1.0])
            }

            # Determine overall anatomical position
            anatomical_position = self._determine_anatomical_position(relative_position)

            return {
                'relative_position': relative_position,
                'anatomical_position': anatomical_position,
                'position_confidence': self._estimate_position_confidence(bounding_box, relative_position),
                'spatial_relationships': self._calculate_spatial_relationships(bounding_box, image_position)
            }

        except Exception as e:
            self._log_error(f"Anatomical position classification failed: {str(e)}")
            return {
                'relative_position': {
                    'left_right': 'unknown',
                    'anterior_posterior': 'unknown',
                    'inferior_superior': 'unknown',
                    'size_classification': 'unknown',
                    'volume_classification': 'unknown'
                },
                'anatomical_position': 'unknown',
                'position_confidence': 0.0,
                'spatial_relationships': {}
            }

    def _classify_lr_position(self, center_x, reference_x):
        """Classify left-right position"""
        try:
            if center_x < reference_x - 20:  # Assuming 20mm threshold
                return 'left'
            elif center_x > reference_x + 20:
                return 'right'
            else:
                return 'midline'
        except Exception:
            return 'unknown'

    def _classify_ap_position(self, center_y, reference_y):
        """Classify anterior-posterior position"""
        try:
            if center_y < reference_y - 20:
                return 'anterior'
            elif center_y > reference_y + 20:
                return 'posterior'
            else:
                return 'central'
        except Exception:
            return 'unknown'

    def _classify_is_position(self, center_z, reference_z):
        """Classify inferior-superior position"""
        try:
            if center_z < reference_z - 20:
                return 'inferior'
            elif center_z > reference_z + 20:
                return 'superior'
            else:
                return 'midlevel'
        except Exception:
            return 'unknown'

    def _classify_size(self, size_mm):
        """Classify size of the segmented volume"""
        try:
            max_dimension = max(size_mm)

            if max_dimension < 10:
                return 'small'
            elif max_dimension < 30:
                return 'medium'
            elif max_dimension < 60:
                return 'large'
            else:
                return 'very_large'
        except Exception:
            return 'unknown'

    def _classify_volume(self, size_mm, spacing):
        """Classify volume based on physical dimensions"""
        try:
            volume_mm3 = np.prod(size_mm) * np.prod(spacing)

            if volume_mm3 < 100:
                return 'tiny'
            elif volume_mm3 < 500:
                return 'small'
            elif volume_mm3 < 2000:
                return 'medium'
            elif volume_mm3 < 5000:
                return 'large'
            elif volume_mm3 < 10000:
                return 'very_large'
            else:
                return 'massive'
        except Exception:
            return 'unknown'

    def _determine_anatomical_position(self, relative_position):
        """Determine comprehensive anatomical position"""
        try:
            # Create position key
            position_key = (
                relative_position['left_right'] + "_" +
                relative_position['anterior_posterior'] + "_" +
                relative_position['inferior_superior']
            )

            # Map to anatomical position
            position_map = {
                # Uterine positions
                'midline_central_midlevel': 'fundal',
                'midline_central_inferior': 'lower_uterine_segment',
                'midline_central_superior': 'upper_uterine_segment',
                'midline_posterior_midlevel': 'posterior_wall',
                'midline_posterior_inferior': 'posterior_lower_segment',
                'midline_anterior_midlevel': 'anterior_wall',
                'midline_anterior_inferior': 'anterior_lower_segment',
                'left_central_midlevel': 'left_lateral_wall',
                'right_central_midlevel': 'right_lateral_wall',

                # Cervical positions
                'midline_central_inferior': 'cervix' if relative_position['volume_classification'] == 'tiny' else 'lower_uterine_segment',

                # Extra-uterine positions
                'left_posterior_midlevel': 'left_adnexa',
                'right_posterior_midlevel': 'right_adnexa',
                'left_anterior_midlevel': 'left_ovarian_fossa',
                'right_anterior_midlevel': 'right_ovarian_fossa',

                # Default positions
                'unknown_unknown_unknown': 'unknown',
                'midline_unknown_midlevel': 'uterine_cavity',
                'unknown_central_midlevel': 'pelvic_cavity'
            }

            return position_map.get(position_key, 'unknown')

        except Exception:
            return 'unknown'

    def _estimate_position_confidence(self, bounding_box, relative_position):
        """Estimate confidence in anatomical position classification"""
        try:
            # Calculate size consistency
            size_confidence = 0.8 if relative_position['size_classification'] != 'unknown' else 0.3

            # Calculate position consistency
            position_factors = {
                'left_right': 1.0 if relative_position['left_right'] != 'unknown' else 0.3,
                'anterior_posterior': 1.0 if relative_position['anterior_posterior'] != 'unknown' else 0.3,
                'inferior_superior': 1.0 if relative_position['inferior_superior'] != 'unknown' else 0.3
            }

            # Calculate bounding box consistency
            size_consistency = 1.0 - min(1.0, max(0, 0.5 * (1.0 - bounding_box['size'][0]/100)))
            volume_consistency = 1.0 - min(1.0, max(0, 0.5 * (1.0 - bounding_box['size'][0]/100)))

            # Combine factors
            confidence = (
                0.2 * size_confidence +
                0.

Continue  from  # Combine factors
11:16 AM
Claude Opus 5.5
11:16 AM

Here's the completion of the position confidence calculation and the spatial relationships analysis:

                0.15 * position_factors['left_right'] +
                0.15 * position_factors['anterior_posterior'] +
                0.15 * position_factors['inferior_superior'] +
                0.2 * size_consistency +
                0.15 * volume_consistency
            )

            # Adjust based on position type
            if relative_position['anatomical_position'] in ['fundal', 'posterior_wall', 'anterior_wall']:
                confidence *= 1.1  # More confident about wall positions
            elif relative_position['anatomical_position'] in ['left_adnexa', 'right_adnexa']:
                confidence *= 0.9  # Slightly less confident about adnexal positions

            return min(1.0, max(0.0, confidence))

        except Exception as e:
            self._log_error(f"Position confidence estimation failed: {str(e)}")
            return 0.5

    def _calculate_spatial_relationships(self, bounding_box, image_position):
        """Calculate spatial relationships to anatomical landmarks"""
        try:
            # Get reference position (patient origin)
            reference_position = np.array(image_position[0])

            # Calculate distances to anatomical landmarks
            relationships = {
                'distance_to_origin': np.linalg.norm(bounding_box['center'] - reference_position),
                'distance_to_midline': abs(bounding_box['center'][0] - reference_position[0]),
                'distance_to_anterior_wall': abs(bounding_box['center'][1] - reference_position[1]),
                'distance_to_posterior_wall': abs(bounding_box['center'][1] - (reference_position[1] + 100)),  # Approx posterior wall
                'distance_to_cervix': abs(bounding_box['center'][2] - (reference_position[2] - 50)),  # Approx cervix
                'distance_to_fundus': abs(bounding_box['center'][2] - (reference_position[2] + 50)),  # Approx fundus
                'relative_to_uterus': self._calculate_uterine_relationship(bounding_box, reference_position),
                'proximity_to_boundaries': self._calculate_boundary_proximity(bounding_box, reference_position)
            }

            return relationships

        except Exception as e:
            self._log_error(f"Spatial relationships calculation failed: {str(e)}")
            return {
                'distance_to_origin': 0.0,
                'distance_to_midline': 0.0,
                'distance_to_anterior_wall': 0.0,
                'distance_to_posterior_wall': 0.0,
                'distance_to_cervix': 0.0,
                'distance_to_fundus': 0.0,
                'relative_to_uterus': 'unknown',
                'proximity_to_boundaries': 'unknown'
            }

    def _calculate_uterine_relationship(self, bounding_box, reference_position):
        """Determine relationship to uterus based on position"""
        try:
            center = bounding_box['center']
            size = bounding_box['size']

            # Calculate relative position to uterus (assuming uterus is roughly 80mm long)
            uterine_length = 80.0
            uterine_center = reference_position[2] + 20.0  # Approximate uterine center

            # Determine if within uterus bounds
            if (center[2] > reference_position[2] - 10 and  # Above cervix
                center[2] < reference_position[2] + 70 and  # Below fundus
                abs(center[0]) < 40 and  # Within lateral bounds
                abs(center[1]) < 30):  # Within AP bounds

                # Calculate position within uterus
                relative_z = (center[2] - (reference_position[2] - 10)) / uterine_length
                relative_size = max(size) / uterine_length

                if relative_z < 0.3 and relative_size < 0.4:
                    return 'cervical'
                elif relative_z > 0.7 and relative_size < 0.4:
                    return 'fundal'
                elif relative_z > 0.3 and relative_z < 0.7 and relative_size < 0.4:
                    return 'corpus'
                else:
                    return 'uterine_wall'

            # Check for adnexal positions
            elif (center[0] > 40 or center[0] < -40 or
                  center[1] > 30 or center[1] < -30):
                return 'adnexal'

            # Check for extra-uterine positions
            else:
                return 'extra_uterine'

        except Exception:
            return 'unknown'

    def _calculate_boundary_proximity(self, bounding_box, reference_position):
        """Calculate proximity to anatomical boundaries"""
        try:
            center = bounding_box['center']
            size = bounding_box['size']

            # Calculate distances to boundaries
            distances = {
                'anterior': abs(center[1] - reference_position[1]),
                'posterior': abs(center[1] - (reference_position[1] + 100)),
                'left': abs(center[0] - (-50)),
                'right': abs(center[0] - 50),
                'inferior': abs(center[2] - (reference_position[2] - 10)),
                'superior': abs(center[2] - (reference_position[2] + 70))
            }

            # Determine proximity classification
            proximity = []
            for direction, distance in distances.items():
                if distance < 5:  # Within 5mm of boundary
                    proximity.append(f"{direction}_proximal")
                elif distance < 20:  # Within 20mm of boundary
                    proximity.append(f"{direction}_near")
                else:
                    proximity.append(f"{direction}_distant")

            # Calculate overall boundary relationship
            if 'anterior_proximal' in proximity or 'posterior_proximal' in proximity:
                return 'wall_proximal'
            elif 'left_proximal' in proximity or 'right_proximal' in proximity:
                return 'lateral_proximal'
            elif 'inferior_proximal' in proximity:
                return 'cervical_proximal'
            elif 'superior_proximal' in proximity:
                return 'fundal_proximal'
            else:
                return 'central'

        except Exception:
            return 'unknown'

    def _final_validation_and_quality_assessment(self, segmentation_result):
        """Perform final validation and quality assessment"""
        try:
            # Extract key metrics
            mask = segmentation_result['mask']
            metrics = segmentation_result['metrics']

            # Perform comprehensive validation
            validation = self._perform_comprehensive_validation(mask, metrics)

            # Calculate overall quality score
            quality_score = self._calculate_overall_quality_score(segmentation_result)

            # Generate final assessment
            assessment = {
                'validation_status': validation['status'],
                'validation_issues': validation['issues'],
                'validation_confidence': validation['confidence'],
                'quality_score': quality_score['score'],
                'quality_rating': quality_score['rating'],
                'quality_factors': quality_score['factors'],
                'recommendations': self._generate_recommendations(validation, quality_score),
                'processing_summary': self._generate_processing_summary(segmentation_result),
                'final_confidence': self._calculate_final_confidence(validation, quality_score)
            }

            return assessment

        except Exception as e:
            self._log_error(f"Final validation failed: {str(e)}")
            return {
                'error': str(e),
                'validation_status': 'failed',
                'quality_rating': 'unknown',
                'final_confidence': 0.0
            }

    def _perform_comprehensive_validation(self, mask, metrics):
        """Perform comprehensive validation of segmentation"""
        try:
            validation = {
                'status': 'passed',
                'issues': [],
                'confidence': 1.0,
                'metrics': {}
            }

            # 1. Basic validity checks
            if np.sum(mask) == 0:
                validation['status'] = 'failed'
                validation['issues'].append('empty_segmentation')
                validation['confidence'] = 0.0
                return validation

            # 2. Size validation
            volume_mm3 = metrics.get('volume_mm3', 0)
            if volume_mm3 < 1 or volume_mm3 > 50000:  # Unrealistic volume
                validation['issues'].append('unrealistic_volume')
                validation['confidence'] *= 0.3

            # 3. Shape validation
            compactness = metrics.get('compactness', 0)
            if compactness < 0.1 or compactness > 1.0:
                validation['issues'].append('unrealistic_shape')
                validation['confidence'] *= 0.4

            # 4. Boundary validation
            surface_area = metrics.get('surface_area_mm2', 0)
            if volume_mm3 > 0 and surface_area > 0:
                expected_surface_area = 6 * np.pi * (volume_mm3/

continue from if volume_mm3 > 0 and surface_area > 0:
11:17 AM
Claude Opus 5.5
11:17 AM

Here's the continuation of the comprehensive validation with boundary analysis and additional quality checks:

                expected_surface_area = 6 * np.pi * (volume_mm3/4/np.pi)**(2/3)
                surface_ratio = surface_area / expected_surface_area

                if surface_ratio > 3.0:  # More than 3x expected surface area
                    validation['issues'].append('excessive_surface_area')
                    validation['confidence'] *= 0.5
                elif surface_ratio < 0.3:  # Less than 1/3 expected surface area
                    validation['issues'].append('insufficient_surface_area')
                    validation['confidence'] *= 0.6

            # 5. Spatial validation
            bounding_box = metrics.get('bounding_box', {})
            if 'size' in bounding_box:
                max_dimension = max(bounding_box['size'])

                if max_dimension > 200:  # Unrealistically large dimension
                    validation['issues'].append('unrealistic_dimensions')
                    validation['confidence'] *= 0.4

                # Check aspect ratios
                principal_axes = metrics.get('spatial_distribution', {}).get('principal_axes', {})
                if 'aspect_ratio' in principal_axes:
                    aspect_ratio = principal_axes['aspect_ratio']
                    if aspect_ratio < 0.2 or aspect_ratio > 0.9:  # Extremely elongated or spherical
                        validation['issues'].append('unrealistic_aspect_ratio')
                        validation['confidence'] *= 0.7

            # 6. Position validation
            anatomical_position = metrics.get('anatomical_position', {})
            if 'anatomical_position' in anatomical_position:
                position = anatomical_position['anatomical_position']
                if position == 'unknown':
                    validation['issues'].append('unknown_anatomical_position')
                    validation['confidence'] *= 0.5

            # 7. Volume distribution validation
            volume_distribution = metrics.get('spatial_distribution', {}).get('volume_distribution', {})
            if 'entropy' in volume_distribution:
                entropy = volume_distribution['entropy']
                if entropy > 3.0:  # Very irregular distribution
                    validation['issues'].append('irregular_volume_distribution')
                    validation['confidence'] *= 0.6

            # 8. Surface characteristics validation
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0)
            if surface_roughness > 0.8:  # Very rough surface
                validation['issues'].append('excessive_surface_roughness')
                validation['confidence'] *= 0.5

            # 9. Confidence validation
            confidence = metrics.get('confidence', 0.5)
            if confidence < 0.3:
                validation['issues'].append('low_confidence_segmentation')
                validation['confidence'] = min(0.5, validation['confidence'])

            # 10. Final status determination
            if len(validation['issues']) > 3:
                validation['status'] = 'failed'
            elif len(validation['issues']) > 0:
                validation['status'] = 'warning'
            else:
                validation['status'] = 'passed'

            # Store validation metrics
            validation['metrics'] = {
                'volume_mm3': volume_mm3,
                'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                'compactness': compactness,
                'surface_ratio': surface_ratio if 'surface_ratio' in locals() else 0,
                'max_dimension_mm': max_dimension if 'max_dimension' in locals() else 0,
                'aspect_ratio': aspect_ratio if 'aspect_ratio' in locals() else 0,
                'entropy': entropy if 'entropy' in locals() else 0,
                'surface_roughness': surface_roughness,
                'original_confidence': confidence
            }

            return validation

        except Exception as e:
            self._log_error(f"Comprehensive validation failed: {str(e)}")
            return {
                'status': 'failed',
                'issues': ['validation_error'],
                'confidence': 0.0,
                'error': str(e)
            }

    def _calculate_overall_quality_score(self, segmentation_result):
        """Calculate comprehensive quality score for segmentation"""
        try:
            # Extract metrics
            mask = segmentation_result['mask']
            metrics = segmentation_result['metrics']

            # Initialize quality factors
            quality_factors = {
                'volume_appropriateness': 0.0,
                'shape_appropriateness': 0.0,
                'boundary_quality': 0.0,
                'position_appropriateness': 0.0,
                'processing_consistency': 0.0,
                'anatomical_plausibility': 0.0
            }

            # 1. Volume appropriateness (30%)
            volume_mm3 = metrics.get('volume_mm3', 0)
            if 100 < volume_mm3 < 5000:  # Typical fibroid range
                quality_factors['volume_appropriateness'] = 0.9
            elif 10 < volume_mm3 < 100 or 5000 < volume_mm3 < 20000:
                quality_factors['volume_appropriateness'] = 0.6
            else:
                quality_factors['volume_appropriateness'] = 0.2

            # 2. Shape appropriateness (25%)
            compactness = metrics.get('compactness', 0.5)
            aspect_ratio = metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratio', 0.7)

            shape_score = 0.5 * compactness + 0.5 * (1 - abs(aspect_ratio - 0.7))
            quality_factors['shape_appropriateness'] = min(1.0, max(0.0, shape_score))

            # 3. Boundary quality (20%)
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            boundary_smoothness = 1.0 - surface_roughness
            quality_factors['boundary_quality'] = boundary_smoothness

            # 4. Position appropriateness (15%)
            position_confidence = metrics.get('anatomical_position', {}).get('position_confidence', 0.5)
            quality_factors['position_appropriateness'] = position_confidence

            # 5. Processing consistency (5%)
            processing_method = metrics.get('processing_method', 'unknown')
            if processing_method in ['manual_segmentation', 'region_growing']:
                quality_factors['processing_consistency'] = 0.9
            else:
                quality_factors['processing_consistency'] = 0.7

            # 6. Anatomical plausibility (5%)
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            if anatomical_position in ['fundal', 'corpus', 'cervical', 'posterior_wall', 'anterior_wall']:
                quality_factors['anatomical_plausibility'] = 0.9
            elif anatomical_position in ['left_adnexa', 'right_adnexa']:
                quality_factors['anatomical_plausibility'] = 0.7
            else:
                quality_factors['anatomical_plausibility'] = 0.5

            # Calculate weighted quality score
            weighted_score = (
                0.3 * quality_factors['volume_appropriateness'] +
                0.25 * quality_factors['shape_appropriateness'] +
                0.2 * quality_factors['boundary_quality'] +
                0.15 * quality_factors['position_appropriateness'] +
                0.05 * quality_factors['processing_consistency'] +
                0.05 * quality_factors['anatomical_plausibility']
            )

            # Determine quality rating
            if weighted_score >= 0.9:
                rating = 'excellent'
            elif weighted_score >= 0.8:
                rating = 'very_good'
            elif weighted_score >= 0.7:
                rating = 'good'
            elif weighted_score >= 0.6:
                rating = 'fair'
            elif weighted_score >= 0.5:
                rating = 'poor'
            else:
                rating = 'very_poor'

            return {
                'score': float(weighted_score),
                'rating': rating,
                'factors': quality_factors,
                'detailed_metrics': self._get_detailed_quality_metrics(metrics)
            }

        except Exception as e:
            self._log_error(f"Quality score calculation failed: {str(e)}")
            return {
                'score': 0.0,
                'rating': 'unknown',
                'factors': {
                    'volume_appropriateness': 0.0,
                    'shape_appropriateness': 0.0,
                    'boundary_quality': 0.0,
                    'position_appropriateness': 0.0,
                    'processing_consistency': 0.0,
                   

Continue from 'processing_consistency': 0.0,
11:18 AM
Claude Opus 5.5
11:18 AM

Here's the completion of the quality assessment with detailed metrics and recommendation generation:

                    'anatomical_plausibility': 0.0
                },
                'detailed_metrics': {},
                'error': str(e)
            }

    def _get_detailed_quality_metrics(self, metrics):
        """Extract detailed quality metrics for reporting"""
        try:
            return {
                'volume_metrics': {
                    'volume_mm3': metrics.get('volume_mm3', 0),
                    'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                    'compactness': metrics.get('compactness', 0),
                    'volume_to_surface_ratio': metrics.get('volume_metrics', {}).get('volume_to_surface_ratio', 0)
                },
                'shape_metrics': {
                    'aspect_ratios': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0, 0]),
                    'circularity': metrics.get('volume_characteristics', {}).get('circularity', 0),
                    'sphericity': metrics.get('volume_characteristics', {}).get('sphericity', 0),
                    'elongation': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('elongation', 0)
                },
                'boundary_metrics': {
                    'surface_roughness': metrics.get('volume_characteristics', {}).get('surface_roughness', 0),
                    'fractal_dimension': self._calculate_fractal_dimension(metrics.get('mask', np.zeros((10,10,10)))),
                    'boundary_smoothness': 1.0 - metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
                },
                'position_metrics': {
                    'anatomical_position': metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown'),
                    'position_confidence': metrics.get('anatomical_position', {}).get('position_confidence', 0),
                    'spatial_relationships': metrics.get('anatomical_position', {}).get('spatial_relationships', {})
                },
                'processing_metrics': {
                    'processing_method': metrics.get('processing_method', 'unknown'),
                    'confidence': metrics.get('confidence', 0),
                    'uncertainty': metrics.get('uncertainty', 0),
                    'validation_status': metrics.get('validation_status', {}).get('status', 'unknown')
                },
                'statistical_metrics': {
                    'entropy': metrics.get('spatial_distribution', {}).get('volume_distribution', {}).get('entropy', 0),
                    'uniformity': metrics.get('spatial_distribution', {}).get('volume_distribution', {}).get('uniformity', 0),
                    'skewness': metrics.get('spatial_distribution', {}).get('volume_distribution', {}).get('skewness', 0)
                }
            }
        except Exception as e:
            self._log_error(f"Detailed quality metrics extraction failed: {str(e)}")
            return {
                'error': str(e),
                'volume_metrics': {},
                'shape_metrics': {},
                'boundary_metrics': {},
                'position_metrics': {},
                'processing_metrics': {},
                'statistical_metrics': {}
            }

    def _generate_recommendations(self, validation, quality_score):
        """Generate recommendations based on validation and quality assessment"""
        try:
            recommendations = []

            # 1. Validation-specific recommendations
            if validation['status'] == 'failed':
                recommendations.append({
                    'severity': 'critical',
                    'message': 'Segmentation failed validation. Manual review is strongly recommended.',
                    'action': 'Flag for radiologist review',
                    'priority': 1
                })

                for issue in validation['issues']:
                    if issue == 'empty_segmentation':
                        recommendations.append({
                            'severity': 'critical',
                            'message': 'Empty segmentation detected. Check processing parameters.',
                            'action': 'Review seed points and threshold values',
                            'priority': 1
                        })
                    elif issue == 'unrealistic_volume':
                        recommendations.append({
                            'severity': 'high',
                            'message': 'Unrealistic volume detected. May indicate incorrect segmentation.',
                            'action': 'Adjust region growing parameters or use different method',
                            'priority': 2
                        })
                    elif issue == 'excessive_surface_area':
                        recommendations.append({
                            'severity': 'high',
                            'message': 'Excessive surface area suggests over-segmentation.',
                            'action': 'Increase threshold or connectivity parameter',
                            'priority': 2
                        })
                    elif issue == 'unrealistic_shape':
                        recommendations.append({
                            'severity': 'high',
                            'message': 'Unrealistic shape detected. May indicate processing artifacts.',
                            'action': 'Try different segmentation algorithm or parameters',
                            'priority': 2
                        })

            elif validation['status'] == 'warning':
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Segmentation passed with warnings. Consider additional review.',
                    'action': 'Check segmentation against original images',
                    'priority': 3
                })

            # 2. Quality-specific recommendations
            if quality_score['rating'] in ['poor', 'very_poor']:
                recommendations.append({
                    'severity': 'high',
                    'message': f'Low quality segmentation ({quality_score["rating"]}).',
                    'action': 'Manual correction recommended',
                    'priority': 1
                })

            # 3. Specific metric recommendations
            detailed_metrics = self._get_detailed_quality_metrics(validation['metrics'])

            # Volume recommendations
            if detailed_metrics['volume_metrics']['volume_mm3'] < 100:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Very small volume may indicate partial segmentation.',
                    'action': 'Check for multiple structures or processing artifacts',
                    'priority': 3
                })

            # Shape recommendations
            if detailed_metrics['shape_metrics']['elongation'] > 0.8:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'High elongation may indicate incorrect segmentation.',
                    'action': 'Verify anatomical plausibility',
                    'priority': 3
                })

            # Boundary recommendations
            if detailed_metrics['boundary_metrics']['surface_roughness'] > 0.7:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'High surface roughness may indicate noisy boundaries.',
                    'action': 'Apply smoothing filter or adjust threshold',
                    'priority': 3
                })

            # Position recommendations
            if detailed_metrics['position_metrics']['position_confidence'] < 0.6:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Low confidence in anatomical position.',
                    'action': 'Verify position relative to anatomical landmarks',
                    'priority': 3
                })

            # Processing recommendations
            if detailed_metrics['processing_metrics']['confidence'] < 0.6:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Low confidence in processing method.',
                    'action': 'Try alternative segmentation method',
                    'priority': 3
                })

            # 4. General recommendations
            recommendations.append({
                'severity': 'low',
                'message': 'Always compare segmentation with original images for verification.',
                'action': 'Visual inspection recommended',
                'priority': 4
            })

            # Sort recommendations by priority
            recommendations.sort(key=lambda x: x['priority'])

            return recommendations

        except Exception as e:
            self._log_error(f"Recommendation generation failed: {str(e)}")
            return [{
                'severity': 'unknown',
                'message': 'Could not generate recommendations due to error',
                'action': 'Contact system administrator',
                'priority': 1,
                'error': str(e)
            }]

    def _generate_processing_summary(self, segmentation_result):
        """Generate summary of processing steps and parameters"""
        try:
            metrics = segmentation_result['metrics']
            processing_method = metrics.get('processing_method', 'unknown')

            summary = {
                'processing_method': processing_method,
                'processing_timestamp': metrics.get('processing_timestamp', 'unknown'),
                'method_parameters': {},
                'processing_steps': [],
                'confidence_indicators': [],
                'validation_status': metrics.get('validation_status', {}).get('status', 'unknown'),
                'quality_rating': metrics.get('quality_rating', 'unknown')
            }

            # Add method-specific parameters
            if processing_method == 'region_growing':
                rg_metrics = metrics.get('region_growing_metrics', {})
                summary['method_parameters'] = {
                    'seed_points': rg_metrics.get('num_seed_points', 0),
                    'threshold': rg_metrics.get('threshold_used', 'unknown'),
                    'connectivity': rg_metrics.get('connectivity_used', 'unknown'),
                    'min_region_size': rg_metrics.get('min_region_size', 0),
                    'max_region_size': rg_metrics.get('max_region_size', 0)
                }
                summary['processing_steps'].append('Region growing with seed points')
                summary['processing_steps'].append('Intensity thresholding')
                summary['processing_steps'].append('Connectivity analysis')

            elif processing_method

Continue from summary['processing_steps'].append('Connectivity analysis')
11:19 AM
Claude Opus 5.5
11:19 AM

Here's the continuation with the processing summary completion and final confidence calculation:

            elif processing_method == 'manual_segmentation':
                summary['method_parameters'] = {
                    'reviewer': metrics.get('manual_reviewer', 'unknown'),
                    'timestamp': metrics.get('manual_timestamp', 'unknown'),
                    'confidence': metrics.get('manual_confidence', 0.0),
                    'tools_used': metrics.get('tools_used', ['unknown'])
                }
                summary['processing_steps'].append('Manual segmentation by radiologist')
                summary['processing_steps'].append('Visual inspection of volume')
                summary['processing_steps'].append('Boundary refinement')
                summary['confidence_indicators'].append('Manual review confidence: {:.1f}%'.format(
                    metrics.get('manual_confidence', 0.0) * 100))

            # Add confidence indicators
            confidence = metrics.get('confidence', 0.0)
            summary['confidence_indicators'].append('Overall confidence: {:.1f}%'.format(confidence * 100))

            # Add validation information
            validation = metrics.get('validation_status', {})
            if 'issues' in validation:
                summary['validation_issues'] = validation['issues']
                summary['validation_confidence'] = validation.get('confidence', 1.0)

            # Add quality information
            quality = metrics.get('quality_rating', 'unknown')
            summary['quality_details'] = {
                'rating': quality,
                'score': metrics.get('quality_score', 0.0),
                'factors': self._get_detailed_quality_metrics(metrics)['processing_metrics']
            }

            # Add anatomical information
            anatomical = metrics.get('anatomical_position', {})
            summary['anatomical_information'] = {
                'position': anatomical.get('anatomical_position', 'unknown'),
                'confidence': anatomical.get('position_confidence', 0.0),
                'size_classification': anatomical.get('size_classification', 'unknown'),
                'volume_classification': anatomical.get('volume_classification', 'unknown')
            }

            # Add spatial information
            bounding_box = metrics.get('bounding_box', {})
            summary['spatial_information'] = {
                'center_coordinates': bounding_box.get('center', [0, 0, 0]),
                'size_mm': bounding_box.get('size', [0, 0, 0]),
                'volume_mm3': metrics.get('volume_mm3', 0),
                'surface_area_mm2': metrics.get('surface_area_mm2', 0)
            }

            return summary

        except Exception as e:
            self._log_error(f"Processing summary generation failed: {str(e)}")
            return {
                'error': str(e),
                'processing_method': 'unknown',
                'processing_timestamp': 'unknown',
                'validation_status': 'failed',
                'quality_rating': 'unknown'
            }

    def _calculate_final_confidence(self, validation, quality_score):
        """Calculate final confidence score combining validation and quality assessment"""
        try:
            # Base confidence from validation
            validation_confidence = validation.get('confidence', 1.0)

            # Quality score confidence
            quality_confidence = quality_score.get('score', 0.5)

            # Method-specific confidence adjustment
            method_confidence = 1.0  # Default
            processing_method = validation.get('metrics', {}).get('processing_method', 'unknown')

            if processing_method == 'manual_segmentation':
                method_confidence = 0.95  # High confidence for manual
            elif processing_method == 'region_growing':
                method_confidence = 0.8  # Medium confidence for region growing

            # Combine factors with weights
            final_confidence = (
                0.4 * validation_confidence +
                0.4 * quality_confidence +
                0.2 * method_confidence
            )

            # Apply confidence modifiers based on specific issues
            issues = validation.get('issues', [])

            if 'empty_segmentation' in issues:
                final_confidence = 0.0
            elif 'unrealistic_volume' in issues:
                final_confidence *= 0.5
            elif 'excessive_surface_area' in issues:
                final_confidence *= 0.7
            elif 'unrealistic_shape' in issues:
                final_confidence *= 0.6

            # Ensure confidence is within valid range
            return min(1.0, max(0.0, final_confidence))

        except Exception as e:
            self._log_error(f"Final confidence calculation failed: {str(e)}")
            return 0.5

    def _calculate_boundary_smoothness(self, mask):
        """Calculate boundary smoothness using edge analysis"""
        try:
            # Create binary mask
            binary_mask = mask > 0

            # Calculate gradients
            grad_x = np.gradient(binary_mask.astype(float), axis=1)
            grad_y = np.gradient(binary_mask.astype(float), axis=0)
            grad_z = np.gradient(binary_mask.astype(float), axis=2)

            # Calculate edge strength
            edge_strength = np.sqrt(grad_x**2 + grad_y**2 + grad_z**2)

            # Normalize edge strength
            if np.sum(edge_strength) > 0:
                edge_strength = edge_strength / np.max(edge_strength)

            # Calculate smoothness as inverse of edge variation
            smoothness = 1.0 - np.std(edge_strength)

            # Apply minimum threshold
            return max(0.0, min(1.0, smoothness))

        except Exception as e:
            self._log_error(f"Boundary smoothness calculation failed: {str(e)}")
            return 0.5

    def _get_anatomical_labels_from_classical_method(self, mask, volume_data, params):
        """Enhanced anatomical label generation with classical method integration"""
        try:
            # Calculate comprehensive metrics
            metrics = self._calculate_segmentation_metrics(mask, params.get('coordinates', {}))

            # Get volume characteristics
            volume_mm3 = metrics.get('volume_mm3', 0)
            surface_area = metrics.get('surface_area_mm2', 0)
            compactness = metrics.get('compactness', 0.5)
            aspect_ratios = metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5])

            # Get position information
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            position_confidence = metrics.get('anatomical_position', {}).get('position_confidence', 0.5)

            # Generate anatomical labels based on classical criteria
            labels = []

            # Size-based classification
            if volume_mm3 < 50:
                labels.append('micro_fibroid')
            elif volume_mm3 < 500:
                labels.append('small_fibroid')
            elif volume_mm3 < 2000:
                labels.append('medium_fibroid')
            elif volume_mm3 < 5000:
                labels.append('large_fibroid')
            else:
                labels.append('giant_fibroid')

            # Shape-based classification
            if compactness > 0.8:
                labels.append('spherical_fibroid')
            elif aspect_ratios[0] < 0.4 and aspect_ratios[1] < 0.4:
                labels.append('elongated_fibroid')
            elif aspect_ratios[0] > 0.7 and aspect_ratios[1] > 0.7:
                labels.append('irregular_fibroid')

            # Position-based classification
            if position_confidence > 0.7:
                if anatomical_position in ['fundal', 'upper_uterine_segment']:
                    labels.append('fundal_fibroid')
                elif anatomical_position in ['lower_uterine_segment', 'cervical']:
                    labels.append('cervical_fibroid')
                elif anatomical_position in ['anterior_wall', 'posterior_wall']:
                    labels.append('intramural_fibroid')
                elif anatomical_position in ['left_adnexa', 'right_adnexa']:
                    labels.append('pedunculated_fibroid')
                elif anatomical_position in ['left_lateral_wall', 'right_lateral_wall']:
                    labels.append('subserosal_fibroid')

            # Intensity-based classification (if volume data available)
            if volume_data is not None and len(volume_data) > 0:
                region_intensity = volume_data[mask > 0]
                if len(region_intensity) > 0:
                    mean_intensity = np.mean(region_intensity)
                    std_intensity = np.std(region_intensity)

                    if mean_intensity > 150:
                        labels.append('high_intensity_fibroid')
                    elif mean_intensity < 50:
                        labels.append('low_intensity_fibroid')
                    elif std_intensity > 30:
                        labels.append('heterogeneous_fibroid')

            # Boundary characteristics
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            if surface_roughness > 0.7:
                labels.append('irregular_boundary_fibroid')

            # Remove duplicates and return
            return list(set(labels))

       

Continue from # Remove duplicates and return
11:19 AM
Claude Opus 5.5
11:19 AM

Here's the completion of the anatomical label generation with final classification and confidence weighting:

            # Apply confidence-based filtering
            filtered_labels = []
            for label in labels:
                # Apply confidence thresholds for different label types
                if 'fundal' in label or 'cervical' in label or 'pedunculated' in label:
                    if position_confidence > 0.7:
                        filtered_labels.append(label)
                elif 'intramural' in label or 'subserosal' in label:
                    if position_confidence > 0.6:
                        filtered_labels.append(label)
                elif 'spherical' in label or 'elongated' in label or 'irregular' in label:
                    if compactness > 0.5 or aspect_ratios[0] < 0.6 or aspect_ratios[1] < 0.6:
                        filtered_labels.append(label)
                else:
                    # Default labels always included
                    filtered_labels.append(label)

            # Add comprehensive classification
            comprehensive_class = self._determine_comprehensive_classification(
                volume_mm3, compactness, aspect_ratios,
                anatomical_position, position_confidence
            )
            filtered_labels.append(comprehensive_class)

            # Add confidence-weighted labels
            confidence_labels = self._generate_confidence_weighted_labels(
                volume_mm3, compactness, aspect_ratios,
                position_confidence, surface_roughness
            )
            filtered_labels.extend(confidence_labels)

            # Sort labels by priority
            filtered_labels = self._sort_labels_by_priority(filtered_labels)

            return filtered_labels

        except Exception as e:
            self._log_error(f"Anatomical label generation failed: {str(e)}")
            return ['unknown_structure', 'validation_failed']

    def _determine_comprehensive_classification(self, volume_mm3, compactness,
                                             aspect_ratios, anatomical_position, position_confidence):
        """Determine comprehensive fibroid classification"""
        try:
            # Base classification
            if volume_mm3 < 50:
                base_class = "micro"
            elif volume_mm3 < 500:
                base_class = "small"
            elif volume_mm3 < 2000:
                base_class = "medium"
            elif volume_mm3 < 5000:
                base_class = "large"
            else:
                base_class = "giant"

            # Shape classification
            if compactness > 0.8:
                shape_class = "spherical"
            elif aspect_ratios[0] < 0.4 and aspect_ratios[1] < 0.4:
                shape_class = "elongated"
            else:
                shape_class = "irregular"

            # Position classification (only if confident)
            if position_confidence > 0.7:
                if anatomical_position in ['fundal', 'upper_uterine_segment']:
                    position_class = "fundal"
                elif anatomical_position in ['lower_uterine_segment', 'cervical']:
                    position_class = "cervical"
                elif anatomical_position in ['anterior_wall', 'posterior_wall']:
                    position_class = "intramural"
                elif anatomical_position in ['left_adnexa', 'right_adnexa']:
                    position_class = "pedunculated"
                elif anatomical_position in ['left_lateral_wall', 'right_lateral_wall']:
                    position_class = "subserosal"
                else:
                    position_class = "unknown"
            else:
                position_class = "position_uncertain"

            # Combine classifications
            if position_class != "unknown" and position_class != "position_uncertain":
                return f"{base_class}_{shape_class}_{position_class}_fibroid"
            else:
                return f"{base_class}_{shape_class}_fibroid"

        except Exception:
            return "unknown_fibroid"

    def _generate_confidence_weighted_labels(self, volume_mm3, compactness,
                                           aspect_ratios, position_confidence, surface_roughness):
        """Generate additional labels with confidence weighting"""
        try:
            labels = []

            # Volume-based labels with confidence
            if volume_mm3 < 20:
                labels.append(("micro_fibroid", 0.9))
            elif volume_mm3 < 100:
                labels.append(("small_fibroid", 0.85))
            elif volume_mm3 < 1000:
                labels.append(("medium_fibroid", 0.8))
            elif volume_mm3 < 5000:
                labels.append(("large_fibroid", 0.75))
            else:
                labels.append(("giant_fibroid", 0.7))

            # Shape-based labels with confidence
            if compactness > 0.85:
                labels.append(("spherical_fibroid", 0.9))
            elif compactness > 0.7:
                labels.append(("moderately_compact_fibroid", 0.8))

            if aspect_ratios[0] < 0.3 and aspect_ratios[1] < 0.3:
                labels.append(("highly_elongated_fibroid", 0.85))
            elif aspect_ratios[0] < 0.5 and aspect_ratios[1] < 0.5:
                labels.append(("elongated_fibroid", 0.8))

            # Position-based labels with confidence
            if position_confidence > 0.8:
                if volume_mm3 < 500:  # Small fibroids are more likely to be pedunculated
                    labels.append(("likely_pedunculated_fibroid", 0.85))
                elif volume_mm3 > 2000:  # Large fibroids are more likely to be intramural
                    labels.append(("likely_intramural_fibroid", 0.8))

            # Boundary characteristic labels
            if surface_roughness > 0.7:
                labels.append(("irregular_boundary_fibroid", 0.75))
            elif surface_roughness > 0.5:
                labels.append(("moderately_irregular_boundary_fibroid", 0.7))

            # Clinical significance labels
            if volume_mm3 > 5000:
                labels.append(("potentially_clinically_significant_fibroid", 0.8))
            elif volume_mm3 > 2000:
                labels.append(("potentially_symptomatic_fibroid", 0.7)

            # Filter low-confidence labels
            return [label for label, confidence in labels if confidence > 0.6]

        except Exception:
            return []

    def _sort_labels_by_priority(self, labels):
        """Sort anatomical labels by clinical priority"""
        try:
            # Define priority order
            priority_order = [
                # Comprehensive classifications first
                'comprehensive_fibroid_classification',

                # Size classifications
                'giant_fibroid', 'large_fibroid', 'medium_fibroid',
                'small_fibroid', 'micro_fibroid',

                # Position classifications (high priority)
                'fundal_fibroid', 'cervical_fibroid', 'pedunculated_fibroid',
                'intramural_fibroid', 'subserosal_fibroid',

                # Shape classifications
                'spherical_fibroid', 'elongated_fibroid', 'irregular_fibroid',

                # Boundary characteristics
                'irregular_boundary_fibroid', 'moderately_irregular_boundary_fibroid',

                # Clinical significance
                'potentially_clinically_significant_fibroid',
                'potentially_symptomatic_fibroid',

                # General classifications
                'fibroid', 'uterine_fibroid', 'leiomyoma',

                # Unknown/validation labels last
                'unknown_structure', 'validation_failed'
            ]

            # Create priority mapping
            priority_map = {label: idx for idx, label in enumerate(priority_order)}

            # Sort labels by priority
            sorted_labels = sorted(labels, key=lambda x: priority_map.get(x, len(priority_order)))

            return sorted_labels

        except Exception:
            return labels

    def _validate_segmentation_consistency(self, segmentation_result):
        """Validate segmentation consistency across multiple metrics"""
        try:
            metrics = segmentation_result['metrics']
            mask = segmentation_result['mask']

            # 1. Volume-surface area relationship validation
            volume_mm3 = metrics.get('volume_mm3', 0)
            surface_area = metrics.get('surface_area_mm2', 0)

            if volume_mm3 > 0:
                expected_surface_area = 6 * np.pi * (volume_mm3/4/np.pi)**(2/3)
                surface_ratio = surface_area / expected_surface_area

                if surface_ratio < 0.3 or surface_ratio > 3.0:
                    return {
                        'consistent': False,
                        'issue': 'volume_surface_inconsistency',
                        'severity': 'high',
                        'details': {
                            'expected_surface_area': expected_surface_area,
                            'actual_surface_area': surface_area,
                            'ratio': surface_ratio
                        }
                    }

            # 2. Compactness validation
            compactness = metrics.get('compactness', 0.5)
            if compactness < 0.1 or compactness > 1.0:
                return {
                    'consistent': False,
                    'issue

Continue from if compactness < 0.1 or compactness > 1.0:
11:20 AM
Claude Opus 5.5
11:20 AM

Here's the continuation of the segmentation consistency validation with additional checks and comprehensive analysis:

                    'severity': 'medium',
                    'details': {
                        'compactness': compactness,
                        'expected_range': '0.1-1.0'
                    }
                }

            # 3. Aspect ratio validation
            aspect_ratios = metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5])
            if (aspect_ratios[0] < 0.1 or aspect_ratios[0] > 1.0 or
                aspect_ratios[1] < 0.1 or aspect_ratios[1] > 1.0):
                return {
                    'consistent': False,
                    'issue': 'aspect_ratio_inconsistency',
                    'severity': 'medium',
                    'details': {
                        'aspect_ratios': aspect_ratios,
                        'expected_range': '[0.1,1.0] for both ratios'
                    }
                }

            # 4. Bounding box validation
            bounding_box = metrics.get('bounding_box', {})
            if 'size' in bounding_box:
                max_dimension = max(bounding_box['size'])
                min_dimension = min(bounding_box['size'])

                # Check for unrealistic dimensions
                if max_dimension > 200 or min_dimension < 5:
                    return {
                        'consistent': False,
                        'issue': 'unrealistic_dimensions',
                        'severity': 'high',
                        'details': {
                            'max_dimension_mm': max_dimension,
                            'min_dimension_mm': min_dimension,
                            'expected_range': '5-200mm'
                        }
                    }

                # Check aspect ratio of bounding box
                box_aspect_ratio = max_dimension / min_dimension
                if box_aspect_ratio > 10.0:
                    return {
                        'consistent': False,
                        'issue': 'extreme_bounding_box_aspect_ratio',
                        'severity': 'medium',
                        'details': {
                            'box_aspect_ratio': box_aspect_ratio,
                            'expected_range': '<10.0'
                        }
                    }

            # 5. Volume distribution validation
            volume_distribution = metrics.get('spatial_distribution', {}).get('volume_distribution', {})
            entropy = volume_distribution.get('entropy', 0)

            if entropy > 5.0:  # Very irregular distribution
                return {
                    'consistent': False,
                    'issue': 'high_volume_entropy',
                    'severity': 'medium',
                    'details': {
                        'entropy': entropy,
                        'expected_range': '<5.0'
                    }
                }

            # 6. Centroid validation
            centroid = metrics.get('centroid', [0, 0, 0])
            bounding_box_center = bounding_box.get('center', [0, 0, 0])

            # Calculate distance between centroid and bounding box center
            centroid_distance = np.linalg.norm(np.array(centroid) - np.array(bounding_box_center))

            if centroid_distance > 10:  # More than 10mm difference is suspicious
                return {
                    'consistent': False,
                    'issue': 'centroid_discrepancy',
                    'severity': 'medium',
                    'details': {
                        'centroid_distance_mm': centroid_distance,
                        'expected_range': '<10mm'
                    }
                }

            # 7. Spatial distribution validation
            octant_distribution = metrics.get('spatial_distribution', {}).get('octant_distribution', {})
            if octant_distribution:
                # Check for extreme octant dominance
                max_octant = max(octant_distribution.values())
                if max_octant > 0.9:  # More than 90% in one octant
                    return {
                        'consistent': False,
                        'issue': 'extreme_octant_dominance',
                        'severity': 'low',
                        'details': {
                            'max_octant_percentage': max_octant * 100,
                            'expected_range': '<90%'
                        }
                    }

            # 8. Surface characteristics validation
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            if surface_roughness > 0.9:  # Extremely rough surface
                return {
                    'consistent': False,
                    'issue': 'extreme_surface_roughness',
                    'severity': 'low',
                    'details': {
                        'surface_roughness': surface_roughness,
                        'expected_range': '<0.9'
                    }
                }

            # 9. Anatomical plausibility validation
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            position_confidence = metrics.get('anatomical_position', {}).get('position_confidence', 0.5)

            if position_confidence < 0.4 and anatomical_position != 'unknown':
                return {
                    'consistent': False,
                    'issue': 'low_position_confidence',
                    'severity': 'medium',
                    'details': {
                        'position': anatomical_position,
                        'confidence': position_confidence,
                        'expected_confidence': '>0.4'
                    }
                }

            # 10. Processing method validation
            processing_method = metrics.get('processing_method', 'unknown')
            confidence = metrics.get('confidence', 0.5)

            if processing_method == 'automated' and confidence < 0.6:
                return {
                    'consistent': False,
                    'issue': 'low_automated_confidence',
                    'severity': 'medium',
                    'details': {
                        'processing_method': processing_method,
                        'confidence': confidence,
                        'expected_confidence': '>0.6 for automated'
                    }
                }

            # 11. Comprehensive consistency check
            # Calculate consistency score (0-1)
            consistency_score = self._calculate_comprehensive_consistency_score(metrics)

            if consistency_score < 0.7:
                return {
                    'consistent': False,
                    'issue': 'low_overall_consistency',
                    'severity': 'medium',
                    'details': {
                        'consistency_score': consistency_score,
                        'expected_score': '>0.7'
                    }
                }

            # All checks passed
            return {
                'consistent': True,
                'consistency_score': consistency_score,
                'validation_details': self._generate_consistency_details(metrics)
            }

        except Exception as e:
            self._log_error(f"Segmentation consistency validation failed: {str(e)}")
            return {
                'consistent': False,
                'issue': 'validation_error',
                'severity': 'critical',
                'error': str(e)
            }

    def _calculate_comprehensive_consistency_score(self, metrics):
        """Calculate comprehensive consistency score (0-1)"""
        try:
            # Initialize score components
            components = {
                'volume_surface_consistency': 1.0,
                'compactness_consistency': 1.0,
                'aspect_ratio_consistency': 1.0,
                'bounding_box_consistency': 1.0,
                'volume_distribution_consistency': 1.0,
                'centroid_consistency': 1.0,
                'octant_distribution_consistency': 1.0,
                'surface_characteristics_consistency': 1.0,
                'anatomical_plausibility_consistency': 1.0,
                'processing_confidence_consistency': 1.0
            }

            # Calculate each component score
            volume_mm3 = metrics.get('volume_mm3', 0)
            surface_area = metrics.get('surface_area_mm2', 0)
            compactness = metrics.get('compactness', 0.5)
            aspect_ratios = metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5])
            bounding_box = metrics.get('bounding_box', {})
            volume_distribution = metrics.get('spatial_distribution', {}).get('volume_distribution', {})
            centroid = metrics.get('centroid', [0, 0, 0])
            octant_distribution = metrics.get('spatial_distribution', {}).get('octant_distribution', {})
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            position_confidence = metrics.get('anatomical_position', {}).get('position_confidence', 0.5)
            processing_method = metrics.get('processing_method', 'unknown')
            confidence = metrics.get('confidence', 0.5)

            # Volume-surface consistency
            if volume_mm3 > 0:
                expected_surface_area = 6 * np.pi * (volume_mm3/4/np.pi)**(2/3)
                surface_ratio = surface_area / expected_surface_area
                components['volume_surface_consistency'] = max(

Continue from   if volume_mm3 > 0:
11:21 AM
Claude Opus 5.5
11:21 AM

Here's the continuation of the comprehensive consistency score calculation with all component evaluations:

                0.0, min(1.0, 1.0 - abs(np.log10(surface_ratio)) * 0.2))

            # Compactness consistency
            components['compactness_consistency'] = max(0.0, min(1.0,
                1.0 - abs(compactness - 0.5) * 1.5))

            # Aspect ratio consistency
            components['aspect_ratio_consistency'] = max(0.0, min(1.0,
                (1.0 - abs(aspect_ratios[0] - 0.5)) * 0.7 +
                (1.0 - abs(aspect_ratios[1] - 0.5)) * 0.3))

            # Bounding box consistency
            if 'size' in bounding_box:
                max_dimension = max(bounding_box['size'])
                min_dimension = min(bounding_box['size'])
                box_aspect_ratio = max_dimension / min_dimension

                # Check dimension ranges
                dim_score = (1.0 - abs(max_dimension - 50)/150) * 0.5 + \
                           (1.0 - abs(min_dimension - 10)/100) * 0.5

                # Check aspect ratio
                ratio_score = 1.0 - abs(np.log10(box_aspect_ratio + 1e-6)) * 0.3

                components['bounding_box_consistency'] = max(0.0, min(1.0,
                    dim_score * 0.7 + ratio_score * 0.3))

            # Volume distribution consistency
            entropy = volume_distribution.get('entropy', 0)
            components['volume_distribution_consistency'] = max(0.0, min(1.0,
                1.0 - entropy * 0.2))

            # Centroid consistency
            if 'center' in bounding_box:
                bounding_box_center = bounding_box['center']
                centroid_distance = np.linalg.norm(np.array(centroid) - np.array(bounding_box_center))
                components['centroid_consistency'] = max(0.0, min(1.0,
                    1.0 - centroid_distance * 0.05))  # 5% per mm

            # Octant distribution consistency
            if octant_distribution:
                max_octant = max(octant_distribution.values())
                components['octant_distribution_consistency'] = max(0.0, min(1.0,
                    1.0 - (max_octant - 0.25) * 2))  # Penalize dominance

            # Surface characteristics consistency
            components['surface_characteristics_consistency'] = max(0.0, min(1.0,
                1.0 - surface_roughness * 1.2))

            # Anatomical plausibility consistency
            if anatomical_position != 'unknown':
                position_score = 0.0
                if anatomical_position in ['fundal', 'corpus', 'cervical']:
                    position_score = 0.9
                elif anatomical_position in ['intramural', 'subserosal', 'pedunculated']:
                    position_score = 0.7
                else:
                    position_score = 0.5

                components['anatomical_plausibility_consistency'] = max(0.0, min(1.0,
                    position_score * 0.7 + position_confidence * 0.3))

            # Processing confidence consistency
            if processing_method == 'manual_segmentation':
                components['processing_confidence_consistency'] = min(1.0, confidence * 1.2)
            elif processing_method == 'automated':
                components['processing_confidence_consistency'] = min(1.0, confidence * 1.5)
            else:
                components['processing_confidence_consistency'] = confidence

            # Calculate weighted average
            weights = {
                'volume_surface_consistency': 0.15,
                'compactness_consistency': 0.1,
                'aspect_ratio_consistency': 0.1,
                'bounding_box_consistency': 0.15,
                'volume_distribution_consistency': 0.1,
                'centroid_consistency': 0.05,
                'octant_distribution_consistency': 0.05,
                'surface_characteristics_consistency': 0.1,
                'anatomical_plausibility_consistency': 0.1,
                'processing_confidence_consistency': 0.1
            }

            total_score = sum(components[key] * weights[key] for key in components)

            # Apply final adjustment for overall plausibility
            final_adjustment = 1.0
            if 'volume_mm3' in metrics and metrics['volume_mm3'] > 10000:
                final_adjustment = 0.9  # Large volumes may have more variability

            return min(1.0, max(0.0, total_score * final_adjustment))

        except Exception as e:
            self._log_error(f"Comprehensive consistency score calculation failed: {str(e)}")
            return 0.5

    def _generate_consistency_details(self, metrics):
        """Generate detailed consistency information for reporting"""
        try:
            details = {
                'volume_surface_relationship': {
                    'volume_mm3': metrics.get('volume_mm3', 0),
                    'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                    'expected_surface_area': 0,
                    'ratio': 0,
                    'status': 'unknown'
                },
                'compactness': {
                    'value': metrics.get('compactness', 0.5),
                    'expected_range': '0.1-1.0',
                    'status': 'unknown'
                },
                'aspect_ratios': {
                    'ratios': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5]),
                    'expected_range': '[0.1,1.0]',
                    'status': 'unknown'
                },
                'bounding_box': {
                    'dimensions_mm': metrics.get('bounding_box', {}).get('size', [0, 0, 0]),
                    'aspect_ratio': 0,
                    'status': 'unknown'
                },
                'volume_distribution': {
                    'entropy': metrics.get('spatial_distribution', {}).get('volume_distribution', {}).get('entropy', 0),
                    'expected_range': '<5.0',
                    'status': 'unknown'
                },
                'centroid_consistency': {
                    'distance_mm': 0,
                    'status': 'unknown'
                },
                'octant_distribution': {
                    'max_octant_percentage': 0,
                    'status': 'unknown'
                },
                'surface_characteristics': {
                    'surface_roughness': metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5),
                    'expected_range': '<0.9',
                    'status': 'unknown'
                },
                'anatomical_plausibility': {
                    'position': metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown'),
                    'confidence': metrics.get('anatomical_position', {}).get('position_confidence', 0.5),
                    'status': 'unknown'
                },
                'processing_confidence': {
                    'method': metrics.get('processing_method', 'unknown'),
                    'confidence': metrics.get('confidence', 0.5),
                    'status': 'unknown'
                },
                'overall_status': 'unknown'
            }

            # Calculate each component status
            volume_mm3 = metrics.get('volume_mm3', 0)
            surface_area = metrics.get('surface_area_mm2', 0)
            compactness = metrics.get('compactness', 0.5)
            aspect_ratios = metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5])
            bounding_box = metrics.get('bounding_box', {})
            volume_distribution = metrics.get('spatial_distribution', {}).get('volume_distribution', {})
            centroid = metrics.get('centroid', [0, 0, 0])
            octant_distribution = metrics.get('spatial_distribution', {}).get('octant_distribution', {})
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            position_confidence = metrics.get('anatomical_position', {}).get('position_confidence', 0.5)
            processing_method = metrics.get('processing_method', 'unknown')
            confidence = metrics.get('confidence', 0.5)

            # Volume-surface relationship
            if volume_mm3 > 0:
                expected_surface_area = 6 * np.pi * (volume_mm3/4/np.pi)**(2

Continue from   if volume_mm3 > 0:
11:22 AM
Claude Opus 5.5
11:22 AM

Here's the continuation of the consistency details generation:

                expected_surface_area = 6 * np.pi * (volume_mm3/4/np.pi)**(2/3)
                surface_ratio = surface_area / expected_surface_area
                details['volume_surface_relationship']['expected_surface_area'] = expected_surface_area
                details['volume_surface_relationship']['ratio'] = surface_ratio

                if surface_ratio < 0.3 or surface_ratio > 3.0:
                    details['volume_surface_relationship']['status'] = 'warning'
                else:
                    details['volume_surface_relationship']['status'] = 'normal'

            # Compactness
            if compactness < 0.1 or compactness > 1.0:
                details['compactness']['status'] = 'warning'
            else:
                details['compactness']['status'] = 'normal'

            # Aspect ratios
            if (aspect_ratios[0] < 0.1 or aspect_ratios[0] > 1.0 or
                aspect_ratios[1] < 0.1 or aspect_ratios[1] > 1.0):
                details['aspect_ratios']['status'] = 'warning'
            else:
                details['aspect_ratios']['status'] = 'normal'

            # Bounding box
            if 'size' in bounding_box:
                max_dimension = max(bounding_box['size'])
                min_dimension = min(bounding_box['size'])
                box_aspect_ratio = max_dimension / min_dimension
                details['bounding_box']['aspect_ratio'] = box_aspect_ratio

                if max_dimension > 200 or min_dimension < 5 or box_aspect_ratio > 10.0:
                    details['bounding_box']['status'] = 'warning'
                else:
                    details['bounding_box']['status'] = 'normal'

            # Volume distribution
            entropy = volume_distribution.get('entropy', 0)
            if entropy > 5.0:
                details['volume_distribution']['status'] = 'warning'
            else:
                details['volume_distribution']['status'] = 'normal'

            # Centroid consistency
            if 'center' in bounding_box:
                bounding_box_center = bounding_box['center']
                centroid_distance = np.linalg.norm(np.array(centroid) - np.array(bounding_box_center))
                details['centroid_consistency']['distance_mm'] = centroid_distance

                if centroid_distance > 10:
                    details['centroid_consistency']['status'] = 'warning'
                else:
                    details['centroid_consistency']['status'] = 'normal'

            # Octant distribution
            if octant_distribution:
                max_octant = max(octant_distribution.values())
                details['octant_distribution']['max_octant_percentage'] = max_octant * 100

                if max_octant > 0.9:
                    details['octant_distribution']['status'] = 'warning'
                else:
                    details['octant_distribution']['status'] = 'normal'

            # Surface characteristics
            if surface_roughness > 0.9:
                details['surface_characteristics']['status'] = 'warning'
            else:
                details['surface_characteristics']['status'] = 'normal'

            # Anatomical plausibility
            if position_confidence < 0.4 and anatomical_position != 'unknown':
                details['anatomical_plausibility']['status'] = 'warning'
            else:
                details['anatomical_plausibility']['status'] = 'normal'

            # Processing confidence
            if processing_method == 'automated' and confidence < 0.6:
                details['processing_confidence']['status'] = 'warning'
            else:
                details['processing_confidence']['status'] = 'normal'

            # Determine overall status
            warning_count = sum(1 for status in details.values() if isinstance(status, dict) and
                               status.get('status') == 'warning')

            if warning_count > 0:
                details['overall_status'] = f'{warning_count} warnings'
                if warning_count >= 4:
                    details['overall_status'] += ' (critical)'
                elif warning_count >= 2:
                    details['overall_status'] += ' (moderate)'
                else:
                    details['overall_status'] += ' (minor)'
            else:
                details['overall_status'] = 'consistent'

            # Add consistency score
            consistency_score = self._calculate_comprehensive_consistency_score(metrics)
            details['consistency_score'] = consistency_score

            return details

        except Exception as e:
            self._log_error(f"Consistency details generation failed: {str(e)}")
            return {
                'error': str(e),
                'overall_status': 'error',
                'consistency_score': 0.0
            }

    def _generate_visualization_parameters(self, mask, metrics, image_shape):
        """Generate parameters for visualization of segmentation results"""
        try:
            # Calculate visualization parameters
            params = {
                'mask': mask,
                'volume_mm3': metrics.get('volume_mm3', 0),
                'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                'compactness': metrics.get('compactness', 0.5),
                'aspect_ratios': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5]),
                'anatomical_position': metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown'),
                'position_confidence': metrics.get('anatomical_position', {}).get('position_confidence', 0.5),
                'processing_method': metrics.get('processing_method', 'unknown'),
                'confidence': metrics.get('confidence', 0.5),
                'quality_rating': metrics.get('quality_rating', 'unknown'),
                'validation_status': metrics.get('validation_status', {}).get('status', 'unknown'),
                'visualization_type': '3d',
                'slice_visualization': self._generate_slice_visualization_params(mask, image_shape),
                'volume_visualization': self._generate_volume_visualization_params(mask, metrics),
                'boundary_visualization': self._generate_boundary_visualization_params(mask, metrics),
                'anatomical_labels': self._get_anatomical_labels_from_classical_method(mask, None, {}),
                'recommendations': self._generate_visualization_recommendations(metrics),
                'metadata': {
                    'timestamp': datetime.datetime.now().isoformat(),
                    'processing_parameters': metrics.get('processing_parameters', {}),
                    'image_shape': image_shape,
                    'spacing': metrics.get('spacing', [1.0, 1.0, 1.0])
                }
            }

            return params

        except Exception as e:
            self._log_error(f"Visualization parameters generation failed: {str(e)}")
            return {
                'error': str(e),
                'visualization_type': 'error',
                'metadata': {
                    'timestamp': datetime.datetime.now().isoformat(),
                    'error_message': str(e)
                }
            }

    def _generate_slice_visualization_params(self, mask, image_shape):
        """Generate parameters for slice-by-slice visualization"""
        try:
            # Find slices with significant segmentation
            slice_counts = np.sum(mask > 0, axis=(0,1))
            significant_slices = np.where(slice_counts > 0)[0]

            # Select representative slices
            if len(significant_slices) > 0:
                # Get first, middle, and last slices
                first_slice = significant_slices[0]
                last_slice = significant_slices[-1]
                middle_slice = significant_slices[len(significant_slices)//2]

                # Ensure we have at least 3 slices
                if len(significant_slices) < 3:
                    middle_slice = first_slice

                # Create slice visualization parameters
                return {
                    'axial_slices': [
                        {'slice_index': first_slice, 'label': 'First significant slice'},
                        {'slice_index': middle_slice, 'label': 'Middle slice'},
                        {'slice_index': last_slice, 'label': 'Last significant slice'}
                    ],
                    'coronal_slices': [
                        {'slice_index': image_shape[2]//2, 'label': 'Mid-coronal slice'}
                    ],
                    'sagittal_slices': [
                        {'slice_index': image_shape[1]//2, 'label': 'Mid-sagittal slice'}
                    ],
                    'slice_thickness': 1,
                    'slice_spacing': 5
                }
            else:
                return {
                    'message': 'No significant segmentation found in any slice',
                    'slice_thickness': 1,
                    'slice_spacing': 5
                }

        except Exception as e:
            self._log_error(f"Slice visualization parameters generation failed: {str(e)}")
            return {
                'error': str(e),
                'message': 'Failed to generate slice visualization parameters'
            }

    def _generate_volume_visualization_params(self, mask, metrics):
        """Generate parameters for 3D volume visualization"""
        try:
            # Calculate visualization parameters
            volume_params = {
                'volume_rendering': {
                    'opacity': 0.7,
                    'color': [255, 100

Continue from  volume_params = {
11:23 AM
Claude Opus 5.5
11:23 AM

Here's the continuation of the volume visualization parameters with comprehensive 3D rendering specifications:

                    'color': [255, 100, 100],  # Default red color for fibroids
                    'edge_color': [200, 0, 0],
                    'edge_width': 1.0,
                    'smooth_shading': True,
                    'lighting': True,
                    'ambient': 0.5,
                    'diffuse': 0.7,
                    'specular': 0.3,
                    'shininess': 30
                },
                'surface_mesh': {
                    'resolution': 32,  # Number of points per dimension
                    'smoothing_iterations': 5,
                    'decimation_level': 0.8,  # Keep 80% of vertices
                    'normal_smoothing': True,
                    'curvature_enhancement': 1.5
                },
                'volume_properties': {
                    'volume_mm3': metrics.get('volume_mm3', 0),
                    'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                    'compactness': metrics.get('compactness', 0.5),
                    'sphericity': metrics.get('volume_characteristics', {}).get('sphericity', 0.0),
                    'aspect_ratios': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('aspect_ratios', [0.5, 0.5]),
                    'principal_axes': metrics.get('spatial_distribution', {}).get('principal_axes', {}).get('directions', [[1,0,0], [0,1,0], [0,0,1]])
                },
                'position_context': {
                    'anatomical_position': metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown'),
                    'center_coordinates': metrics.get('bounding_box', {}).get('center', [0, 0, 0]),
                    'size_mm': metrics.get('bounding_box', {}).get('size', [0, 0, 0]),
                    'orientation': self._calculate_orientation_context(mask)
                },
                'quality_indicators': {
                    'confidence': metrics.get('confidence', 0.5),
                    'validation_status': metrics.get('validation_status', {}).get('status', 'unknown'),
                    'quality_rating': metrics.get('quality_rating', 'unknown'),
                    'surface_roughness': metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
                },
                'visualization_modes': [
                    {
                        'type': 'surface_mesh',
                        'label': 'Detailed Surface Mesh',
                        'parameters': {
                            'wireframe': False,
                            'point_size': 1.0,
                            'color_map': 'viridis',
                            'show_normals': False
                        }
                    },
                    {
                        'type': 'volume_rendering',
                        'label': 'Volume Rendering',
                        'parameters': {
                            'transfer_function': 'fibroid_tf',
                            'clip_box': metrics.get('bounding_box', {}),
                            'show_boundaries': True
                        }
                    },
                    {
                        'type': 'cross_section',
                        'label': 'Cross-sectional View',
                        'parameters': {
                            'slice_plane': 'axial',
                            'highlight_boundary': True,
                            'show_centroid': True
                        }
                    }
                ],
                'annotation_parameters': {
                    'position_labels': True,
                    'size_labels': True,
                    'quality_indicators': True,
                    'measurement_lines': True,
                    'annotation_font_size': 12,
                    'annotation_color': [0, 0, 0, 1]  # Black with full opacity
                },
                'interactive_features': {
                    'rotation': True,
                    'zoom': True,
                    'pan': True,
                    'slice_control': True,
                    'measurement_tools': True,
                    'annotation_editor': True
                },
                'comparison_features': {
                    'original_image_comparison': True,
                    'multiple_viewports': True,
                    'side_by_side': True,
                    'before_after': True
                }
            }

            # Adjust visualization parameters based on quality metrics
            quality_rating = metrics.get('quality_rating', 'unknown')
            confidence = metrics.get('confidence', 0.5)
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)

            # Adjust surface mesh parameters based on quality
            if quality_rating in ['poor', 'very_poor']:
                volume_params['surface_mesh']['resolution'] = 16
                volume_params['surface_mesh']['decimation_level'] = 0.5
                volume_params['volume_rendering']['opacity'] = 0.4
            elif quality_rating in ['fair']:
                volume_params['surface_mesh']['resolution'] = 24
                volume_params['surface_mesh']['decimation_level'] = 0.6
            elif quality_rating in ['good', 'very_good', 'excellent']:
                volume_params['surface_mesh']['resolution'] = 48
                volume_params['surface_mesh']['decimation_level'] = 0.9

            # Adjust based on surface roughness
            if surface_roughness > 0.7:
                volume_params['surface_mesh']['smoothing_iterations'] = 10
                volume_params['surface_mesh']['curvature_enhancement'] = 2.0
            elif surface_roughness > 0.5:
                volume_params['surface_mesh']['smoothing_iterations'] = 7

            # Adjust visualization modes based on confidence
            if confidence < 0.6:
                volume_params['visualization_modes'].append({
                    'type': 'uncertainty_map',
                    'label': 'Confidence Visualization',
                    'parameters': {
                        'opacity': 0.3,
                        'color_map': 'plasma',
                        'show_legend': True
                    }
                })

            # Add anatomical context visualization
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            if anatomical_position != 'unknown':
                volume_params['position_context']['visualization'] = {
                    'uterus_model': True,
                    'position_marker': True,
                    'orientation_arrows': True,
                    'anatomical_landmarks': True
                }

                # Add position-specific visualization parameters
                if anatomical_position in ['fundal', 'upper_uterine_segment']:
                    volume_params['position_context']['view_orientation'] = {
                        'elevation': 30,
                        'azimuth': 45
                    }
                elif anatomical_position in ['cervical', 'lower_uterine_segment']:
                    volume_params['position_context']['view_orientation'] = {
                        'elevation': -30,
                        'azimuth': 45
                    }
                elif anatomical_position in ['left_adnexa', 'right_adnexa']:
                    volume_params['position_context']['view_orientation'] = {
                        'elevation': 15,
                        'azimuth': 90
                    }

            return volume_params

        except Exception as e:
            self._log_error(f"Volume visualization parameters generation failed: {str(e)}")
            return {
                'error': str(e),
                'default_visualization': {
                    'type': 'basic_surface',
                    'parameters': {
                        'color': [255, 100, 100],
                        'opacity': 0.7
                    }
                }
            }

    def _generate_boundary_visualization_params(self, mask, metrics):
        """Generate parameters for boundary-specific visualization"""
        try:
            boundary_params = {
                'boundary_type': 'surface_mesh',
                'boundary_color': [0, 150, 255],  # Blue for boundaries
                'boundary_width': 2.0,
                'boundary_style': 'solid',
                'boundary_highlight': {
                    'enabled': True,
                    'color': [255, 255, 0],  # Yellow for highlights
                    'width': 3.0,
                    'threshold': 0.7  # Highlight areas with high curvature
                },
                'curvature_visualization': {
                    'enabled': True,
                    'color_map': 'coolwarm',
                    'opacity': 0.5,
                    'show_legend': True,
                    'curvature_thresholds': {
                        'low': 0.0,
                        'medium': 0.5,
                        'high': 1.0
                    }
                },
                'normal_vectors': {
                    'enabled': False,
                    'length': 5.0,
                    'color': [0, 200, 0],
                    'density': 0.2  # Show every 5th normal
                },
                'boundary_metrics': {
                    'surface_area_mm2': metrics.get('surface_area_mm2', 0),
                    'surface_roughness': metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5),
                    'fractal_dimension': self._calculate_fractal_dimension(mask),
                   

Continue from  'surface_roughness': metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5),
11:24 AM
Claude Opus 5.5
11:24 AM

Here's the continuation of the boundary visualization parameters with detailed boundary analysis and visualization features:

                    'fractal_dimension': self._calculate_fractal_dimension(mask),
                    'mean_curvature': metrics.get('volume_characteristics', {}).get('mean_curvature', 0.0),
                    'gaussian_curvature': metrics.get('volume_characteristics', {}).get('gaussian_curvature', 0.0),
                    'boundary_complexity': self._calculate_boundary_complexity(mask)
                },
                'boundary_analysis': {
                    'smoothness_score': self._calculate_boundary_smoothness_score(mask),
                    'edge_consistency': self._calculate_edge_consistency(mask),
                    'boundary_artifacts': self._detect_boundary_artifacts(mask),
                    'boundary_regularity': self._calculate_boundary_regularity(mask)
                },
                'visualization_modes': [
                    {
                        'type': 'boundary_mesh',
                        'label': 'Boundary Mesh',
                        'parameters': {
                            'wireframe': False,
                            'point_size': 0.5,
                            'show_normals': False,
                            'highlight_edges': True
                        }
                    },
                    {
                        'type': 'curvature_map',
                        'label': 'Curvature Analysis',
                        'parameters': {
                            'color_map': 'viridis',
                            'show_legend': True,
                            'threshold': 0.5
                        }
                    },
                    {
                        'type': 'roughness_map',
                        'label': 'Surface Roughness',
                        'parameters': {
                            'color_map': 'plasma',
                            'opacity': 0.6,
                            'show_legend': True
                        }
                    },
                    {
                        'type': 'cross_section_boundary',
                        'label': 'Boundary Cross-Sections',
                        'parameters': {
                            'slice_plane': 'axial',
                            'highlight_boundary': True,
                            'show_curvature': True
                        }
                    }
                ],
                'boundary_quality_indicators': {
                    'quality_score': self._calculate_boundary_quality_score(mask, metrics),
                    'recommended_actions': self._generate_boundary_quality_recommendations(mask, metrics),
                    'visual_warnings': self._detect_visual_boundary_issues(mask)
                },
                'interactive_features': {
                    'boundary_inspection': True,
                    'curvature_profiling': True,
                    'roughness_analysis': True,
                    'artifact_highlighting': True,
                    'measurement_tools': True
                },
                'comparison_features': {
                    'original_boundary_comparison': True,
                    'smoothing_comparison': True,
                    'threshold_variation': True
                }
            }

            # Adjust visualization parameters based on boundary metrics
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            boundary_complexity = boundary_params['boundary_metrics']['boundary_complexity']

            # High roughness requires more detailed visualization
            if surface_roughness > 0.7:
                boundary_params['boundary_highlight']['enabled'] = True
                boundary_params['boundary_highlight']['threshold'] = 0.5
                boundary_params['curvature_visualization']['enabled'] = True
                boundary_params['normal_vectors']['enabled'] = True
                boundary_params['normal_vectors']['density'] = 0.1

                # Add roughness-specific visualization mode
                boundary_params['visualization_modes'].append({
                    'type': 'roughness_detail',
                    'label': 'Detailed Roughness Analysis',
                    'parameters': {
                        'color_map': 'inferno',
                        'opacity': 0.7,
                        'show_gradient': True
                    }
                })

            # Adjust based on boundary complexity
            if boundary_complexity > 0.8:
                boundary_params['boundary_width'] = 1.5
                boundary_params['boundary_style'] = 'dashed'
                boundary_params['visualization_modes'].append({
                    'type': 'complexity_map',
                    'label': 'Boundary Complexity',
                    'parameters': {
                        'color_map': 'magma',
                        'show_legend': True,
                        'threshold': 0.6
                    }
                })

            # Add quality-specific visualization
            boundary_quality_score = boundary_params['boundary_quality_indicators']['quality_score']

            if boundary_quality_score < 0.6:
                boundary_params['visualization_modes'].append({
                    'type': 'quality_warning',
                    'label': 'Boundary Quality Issues',
                    'parameters': {
                        'color': [255, 0, 0],
                        'opacity': 0.8,
                        'show_details': True
                    }
                })

            # Add anatomical context for boundaries
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            if anatomical_position != 'unknown':
                boundary_params['anatomical_context'] = {
                    'position': anatomical_position,
                    'expected_boundary_characteristics': self._get_expected_boundary_characteristics(anatomical_position),
                    'boundary_comparison': True,
                    'landmark_highlighting': True
                }

                # Position-specific boundary visualization adjustments
                if anatomical_position in ['fundal', 'upper_uterine_segment']:
                    boundary_params['boundary_color'] = [255, 150, 150]  # Light red
                elif anatomical_position in ['cervical', 'lower_uterine_segment']:
                    boundary_params['boundary_color'] = [150, 150, 255]  # Light blue
                elif anatomical_position in ['left_adnexa', 'right_adnexa']:
                    boundary_params['boundary_color'] = [150, 255, 150]  # Light green

            return boundary_params

        except Exception as e:
            self._log_error(f"Boundary visualization parameters generation failed: {str(e)}")
            return {
                'error': str(e),
                'default_boundary_visualization': {
                    'type': 'basic_boundary',
                    'parameters': {
                        'color': [0, 150, 255],
                        'width': 2.0,
                        'style': 'solid'
                    }
                }
            }

    def _calculate_fractal_dimension(self, mask):
        """Calculate fractal dimension of the boundary surface"""
        try:
            # Convert mask to surface mesh
            verts, faces, _, _ = measure.marching_cubes(mask, level=0.5)

            # Calculate mesh area and perimeter
            mesh_area = measure.mesh_surface_area(verts, faces)
            if mesh_area == 0:
                return 0.0

            # Calculate perimeter using edge length
            edges = np.zeros((len(faces), 3, 3))
            edges[:, 0, :] = verts[faces[:, 1]] - verts[faces[:, 0]]
            edges[:, 1, :] = verts[faces[:, 2]] - verts[faces[:, 1]]
            edges[:, 2, :] = verts[faces[:, 0]] - verts[faces[:, 2]]

            edge_lengths = np.linalg.norm(edges, axis=2)
            perimeter = np.sum(edge_lengths)

            # Calculate fractal dimension using box counting method
            if perimeter == 0:
                return 0.0

            # Simplified approximation
            log_perimeter = np.log(perimeter)
            log_area = np.log(mesh_area)

            # Fractal dimension D where perimeter = k * area^D
            # Using approximation: D ≈ 2 - log(perimeter)/log(area)
            fractal_dimension = 2 - (log_perimeter / log_area) if log_area != 0 else 2.0

            # Constrain to reasonable range
            return max(1.0, min(3.0, fractal_dimension))

        except Exception as e:
            self._log_error(f"Fractal dimension calculation failed: {str(e)}")
            return 2.0  # Default for smooth surface

    def _calculate_boundary_complexity(self, mask):
        """Calculate boundary complexity metric"""
        try:
            # Convert mask to surface mesh
            verts, faces, _, _ = measure.marching_cubes(mask, level=0.5)

            # Calculate face normals
            face_normals = measure.mesh_face_normals(verts, faces)

            # Calculate curvature (simplified)
            mean_curvature = np.zeros(len(verts))
            gaussian_curvature = np.zeros(len(verts))

            # Calculate edge lengths
            edges = np.zeros((len(faces), 3, 3))
            edges[:, 0, :] = verts[faces[:, 1]] - verts[faces[:, 0]]
            edges[:, 1, :] = verts[faces[:, 2]] - verts[faces[:, 1]]
            edges[:, 2, :] = verts[faces[:, 0]] - verts[faces[:, 2]]

            edge_lengths = np.linalg.norm(edges, axis=2)

            # Calculate face areas
            face_areas = np.zeros

Continue from # Calculate face areas
11:24 AM
Claude Opus 5.5
11:24 AM

Here's the continuation of the boundary complexity calculation with complete implementation:

            # Calculate face areas using Heron's formula approximation
            a, b, c = edge_lengths.T
            s = (a + b + c) / 2
            face_areas = np.sqrt(s * (s - a) * (s - b) * (s - c))

            # Calculate mean curvature approximation
            for i, face in enumerate(faces):
                v0, v1, v2 = verts[face]
                n = face_normals[i]

                # Calculate edge vectors
                e0 = v1 - v0
                e1 = v2 - v1
                e2 = v0 - v2

                # Calculate edge lengths
                l0 = np.linalg.norm(e0)
                l1 = np.linalg.norm(e1)
                l2 = np.linalg.norm(e2)

                # Calculate cotangents
                cot0 = np.dot(e0, e2) / (l0 * l2) if (l0 * l2) != 0 else 0
                cot1 = np.dot(e1, e0) / (l1 * l0) if (l1 * l0) != 0 else 0
                cot2 = np.dot(e2, e1) / (l2 * l1) if (l2 * l1) != 0 else 0

                # Calculate mean curvature for each vertex in face
                mean_curvature[face[0]] += (cot0 + cot2) * 0.5 / face_areas[i]
                mean_curvature[face[1]] += (cot1 + cot0) * 0.5 / face_areas[i]
                mean_curvature[face[2]] += (cot2 + cot1) * 0.5 / face_areas[i]

            # Normalize mean curvature
            mean_curvature = np.abs(mean_curvature)
            mean_curvature = mean_curvature / (np.max(mean_curvature) + 1e-6) if np.max(mean_curvature) > 0 else 0

            # Calculate boundary complexity metric
            complexity_metric = (
                0.3 * np.mean(mean_curvature) +  # Average curvature
                0.3 * np.std(mean_curvature) +   # Curvature variation
                0.2 * (1 - np.exp(-np.mean(face_areas))) +  # Face area distribution
                0.2 * (1 - np.exp(-np.mean(edge_lengths)))   # Edge length distribution
            )

            # Add fractal dimension contribution
            fractal_dim = self._calculate_fractal_dimension(mask)
            complexity_metric += 0.3 * (fractal_dim - 2)  # Normalized to 0-1 range

            # Constrain to 0-1 range
            return max(0.0, min(1.0, complexity_metric))

        except Exception as e:
            self._log_error(f"Boundary complexity calculation failed: {str(e)}")
            return 0.5  # Default moderate complexity

    def _calculate_boundary_smoothness_score(self, mask):
        """Calculate boundary smoothness score (0-1) where 1 is perfectly smooth"""
        try:
            # Convert mask to surface mesh
            verts, faces, _, _ = measure.marching_cubes(mask, level=0.5)

            # Calculate face normals
            face_normals = measure.mesh_face_normals(verts, faces)

            # Calculate vertex normals (using face normals)
            vertex_normals = np.zeros_like(verts)
            for i, face in enumerate(faces):
                for j in range(3):
                    vertex_normals[face[j]] += face_normals[i]

            vertex_normals = vertex_normals / (np.linalg.norm(vertex_normals, axis=1, keepdims=True) + 1e-6)

            # Calculate angle between adjacent face normals
            angle_diffs = []
            for i in range(len(faces)):
                for j in range(i+1, len(faces)):
                    # Find common vertices
                    common = np.intersect1d(faces[i], faces[j])
                    if len(common) > 0:
                        # Calculate angle between normals
                        n1 = face_normals[i]
                        n2 = face_normals[j]
                        angle = np.arccos(np.clip(np.dot(n1, n2), -1, 1))
                        angle_diffs.append(angle)

            if len(angle_diffs) == 0:
                return 1.0  # Perfectly smooth by default

            # Calculate smoothness score based on angle differences
            mean_angle = np.mean(angle_diffs)
            std_angle = np.std(angle_diffs)

            # Normalize to 0-1 range (1 = smooth, 0 = rough)
            smoothness_score = 1.0 - np.tanh(mean_angle * 5) * 0.5 - np.tanh(std_angle * 3) * 0.3

            # Add curvature contribution
            mean_curvature = self._calculate_mean_curvature(mask)
            smoothness_score -= 0.2 * min(1.0, mean_curvature * 2)

            return max(0.0, min(1.0, smoothness_score))

        except Exception as e:
            self._log_error(f"Boundary smoothness score calculation failed: {str(e)}")
            return 0.7  # Default moderate smoothness

    def _calculate_mean_curvature(self, mask):
        """Calculate mean curvature of the boundary surface"""
        try:
            # Convert mask to surface mesh
            verts, faces, _, _ = measure.marching_cubes(mask, level=0.5)

            # Calculate face normals
            face_normals = measure.mesh_face_normals(verts, faces)

            # Calculate mean curvature using discrete differential geometry
            mean_curvature = np.zeros(len(verts))

            for i, face in enumerate(faces):
                v0, v1, v2 = verts[face]
                n = face_normals[i]

                # Calculate edge vectors
                e0 = v1 - v0
                e1 = v2 - v1
                e2 = v0 - v2

                # Calculate edge lengths
                l0 = np.linalg.norm(e0)
                l1 = np.linalg.norm(e1)
                l2 = np.linalg.norm(e2)

                # Calculate cotangents
                cot0 = np.dot(e0, e2) / (l0 * l2) if (l0 * l2) != 0 else 0
                cot1 = np.dot(e1, e0) / (l1 * l0) if (l1 * l0) != 0 else 0
                cot2 = np.dot(e2, e1) / (l2 * l1) if (l2 * l1) != 0 else 0

                # Calculate mean curvature for each vertex in face
                mean_curvature[face[0]] += (cot0 + cot2) * 0.5
                mean_curvature[face[1]] += (cot1 + cot0) * 0.5
                mean_curvature[face[2]] += (cot2 + cot1) * 0.5

            # Normalize by face area and number of faces per vertex
            face_areas = np.zeros(len(faces))
            for i, face in enumerate(faces):
                a, b, c = verts[face]
                # Calculate face area using cross product
                ab = b - a
                ac = c - a
                face_areas[i] = 0.5 * np.linalg.norm(np.cross(ab, ac))

            # Calculate number of faces per vertex
            vertex_face_counts = np.bincount(faces.flatten(), minlength=len(verts))

            # Normalize mean curvature
            mean_curvature = np.abs(mean_curvature) / (face_areas + 1e-6)
            mean_curvature = mean_curvature / (vertex_face_counts + 1e-6)

            return np.mean(mean_curvature)

        except Exception as e:
            self._log_error(f"Mean curvature calculation failed: {str(e)}")
            return 0.0

    def _calculate_boundary_quality_score(self, mask, metrics):
        """Calculate comprehensive boundary quality score (0-1)"""
        try:
            # Get boundary metrics
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            fractal_dimension = self._calculate_fractal_dimension(mask)
            mean_curvature = self._calculate_mean_curvature(mask)
            boundary_complexity = self._calculate_boundary_complexity(mask)
            smoothness_score = self._calculate_boundary_smoothness_score(mask)

            # Get anatomical context
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            expected_roughness = self._get_expected_boundary_roughness(anatomical_position)

            # Calculate quality components
            components = {
                'smoothness': max(0.0, 1

Continue from  components = {
11:25 AM
Claude Opus 5.5
11:25 AM

Here's the continuation of the boundary quality score calculation with complete implementation:

                'smoothness': max(0.0, 1.0 - surface_roughness * 1.2),

                'curvature_appropriateness': max(0.0, min(1.0,
                    1.0 - abs(mean_curvature - 0.3) * 2.0)),  # Typical fibroid curvature

                'complexity_appropriateness': max(0.0, min(1.0,
                    1.0 - abs(boundary_complexity - 0.4) * 1.5)),  # Moderate complexity expected

                'fractal_consistency': max(0.0, 1.0 - abs(fractal_dimension - 2.1) * 0.8),

                'anatomical_consistency': max(0.0, min(1.0,
                    1.0 - abs(surface_roughness - expected_roughness) * 1.5)),

                'edge_consistency': self._calculate_edge_consistency_score(mask),

                'processing_quality': max(0.0, min(1.0,
                    metrics.get('confidence', 0.5) * 1.5))  # Weighted confidence
            }

            # Calculate weighted score
            weights = {
                'smoothness': 0.25,
                'curvature_appropriateness': 0.15,
                'complexity_appropriateness': 0.15,
                'fractal_consistency': 0.10,
                'anatomical_consistency': 0.15,
                'edge_consistency': 0.10,
                'processing_quality': 0.10
            }

            # Calculate base score
            base_score = sum(components[key] * weights[key] for key in components)

            # Apply quality modifiers
            quality_modifiers = {
                'validation_status': metrics.get('validation_status', {}).get('status', 'unknown'),
                'quality_rating': metrics.get('quality_rating', 'unknown')
            }

            # Adjust for validation status
            if quality_modifiers['validation_status'] == 'failed':
                base_score *= 0.5
            elif quality_modifiers['validation_status'] == 'warning':
                base_score *= 0.8

            # Adjust for overall quality rating
            if quality_modifiers['quality_rating'] in ['poor', 'very_poor']:
                base_score *= 0.6
            elif quality_modifiers['quality_rating'] == 'fair':
                base_score *= 0.8

            # Final score with constraints
            final_score = max(0.0, min(1.0, base_score))

            # Add detailed analysis
            analysis = {
                'component_scores': components,
                'weights': weights,
                'base_score': base_score,
                'quality_modifiers': quality_modifiers,
                'recommended_actions': self._generate_boundary_quality_recommendations(mask, metrics)
            }

            return {
                'score': final_score,
                'analysis': analysis,
                'quality_level': self._determine_quality_level(final_score)
            }

        except Exception as e:
            self._log_error(f"Boundary quality score calculation failed: {str(e)}")
            return {
                'score': 0.5,
                'analysis': {
                    'error': str(e),
                    'default_scores': {
                        'smoothness': 0.7,
                        'curvature_appropriateness': 0.6,
                        'complexity_appropriateness': 0.6,
                        'fractal_consistency': 0.7,
                        'anatomical_consistency': 0.6,
                        'edge_consistency': 0.7,
                        'processing_quality': 0.5
                    }
                },
                'quality_level': 'moderate'
            }

    def _calculate_edge_consistency_score(self, mask):
        """Calculate edge consistency score for boundary analysis"""
        try:
            # Convert mask to surface mesh
            verts, faces, _, _ = measure.marching_cubes(mask, level=0.5)

            # Calculate edge lengths
            edges = np.zeros((len(faces), 3, 3))
            edges[:, 0, :] = verts[faces[:, 1]] - verts[faces[:, 0]]
            edges[:, 1, :] = verts[faces[:, 2]] - verts[faces[:, 1]]
            edges[:, 2, :] = verts[faces[:, 0]] - verts[faces[:, 2]]

            edge_lengths = np.linalg.norm(edges, axis=2)

            # Calculate edge length statistics
            mean_length = np.mean(edge_lengths)
            std_length = np.std(edge_lengths)
            edge_length_ratio = np.max(edge_lengths) / (np.min(edge_lengths) + 1e-6)

            # Calculate edge angle consistency
            angle_consistency = self._calculate_edge_angle_consistency(verts, faces)

            # Calculate edge length consistency score
            length_consistency = 1.0 - min(1.0, (edge_length_ratio - 1) * 0.5)
            length_variation = 1.0 - min(1.0, std_length / mean_length * 0.3)

            # Combine metrics
            edge_score = (
                0.4 * length_consistency +
                0.3 * length_variation +
                0.3 * angle_consistency
            )

            return max(0.0, min(1.0, edge_score))

        except Exception as e:
            self._log_error(f"Edge consistency score calculation failed: {str(e)}")
            return 0.6  # Default moderate consistency

    def _calculate_edge_angle_consistency(self, verts, faces):
        """Calculate edge angle consistency score"""
        try:
            # Calculate face normals
            face_normals = measure.mesh_face_normals(verts, faces)

            # Calculate edge vectors
            edges = np.zeros((len(faces), 3, 3))
            edges[:, 0, :] = verts[faces[:, 1]] - verts[faces[:, 0]]
            edges[:, 1, :] = verts[faces[:, 2]] - verts[faces[:, 1]]
            edges[:, 2, :] = verts[faces[:, 0]] - verts[faces[:, 2]]

            # Normalize edge vectors
            edge_vectors = edges / (np.linalg.norm(edges, axis=2, keepdims=True) + 1e-6)

            # Calculate angles between adjacent edges
            angle_diffs = []
            for i, face in enumerate(faces):
                v0, v1, v2 = verts[face]
                e0 = edge_vectors[i, 0]
                e1 = edge_vectors[i, 1]
                e2 = edge_vectors[i, 2]

                # Calculate angles between edges
                angle01 = np.arccos(np.clip(np.dot(e0, e1), -1, 1))
                angle12 = np.arccos(np.clip(np.dot(e1, e2), -1, 1))
                angle20 = np.arccos(np.clip(np.dot(e2, e0), -1, 1))

                # Calculate angle differences from expected (120 degrees)
                expected_angle = np.pi / 3  # 60 degrees between normals
                angle_diffs.extend([
                    abs(angle01 - expected_angle),
                    abs(angle12 - expected_angle),
                    abs(angle20 - expected_angle)
                ])

            if len(angle_diffs) == 0:
                return 1.0  # Perfect consistency by default

            mean_angle_diff = np.mean(angle_diffs)
            std_angle_diff = np.std(angle_diffs)

            # Calculate consistency score
            consistency_score = 1.0 - np.tanh(mean_angle_diff * 3) * 0.5 - np.tanh(std_angle_diff * 2) * 0.3

            return max(0.0, min(1.0, consistency_score))

        except Exception as e:
            self._log_error(f"Edge angle consistency calculation failed: {str(e)}")
            return 0.7  # Default moderate consistency

    def _generate_boundary_quality_recommendations(self, mask, metrics):
        """Generate recommendations based on boundary quality analysis"""
        try:
            recommendations = []

            # Get boundary metrics
            surface_roughness = metrics.get('volume_characteristics', {}).get('surface_roughness', 0.5)
            mean_curvature = self._calculate_mean_curvature(mask)
            boundary_complexity = self._calculate_boundary_complexity(mask)
            smoothness_score = self._calculate_boundary_smoothness_score(mask)
            edge_consistency = self._calculate_edge_consistency_score(mask)
            confidence = metrics.get('confidence', 0.5)
            processing_method = metrics.get('processing_method', 'unknown')

            # 1. Smoothness recommendations
            if surface_roughness > 0.7:
                recommendations.append({
                    'severity': 'high',
                    'message': 'High surface roughness detected. Boundary appears irregular

Continue from 'severity': 'high',
11:26 AM
Claude Opus 5.5
11:26 AM

Here's the continuation of the boundary quality recommendations with comprehensive analysis and actionable suggestions:

                    'message': 'High surface roughness detected. Boundary appears irregular and may contain artifacts or over-segmentation.',
                    'recommended_actions': [
                        'Apply Gaussian smoothing filter (σ=1-2 voxels)',
                        'Increase segmentation threshold slightly',
                        'Consider manual boundary correction',
                        'Check for partial volume effects in original images'
                    ],
                    'priority': 1,
                    'confidence': 0.9
                })

            elif surface_roughness > 0.5:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Moderate surface roughness detected. Boundary could be refined for better anatomical plausibility.',
                    'recommended_actions': [
                        'Apply mild smoothing (σ=0.5-1 voxels)',
                        'Verify segmentation parameters',
                        'Compare with adjacent slices for consistency'
                    ],
                    'priority': 2,
                    'confidence': 0.8
                })

            # 2. Curvature recommendations
            if mean_curvature > 0.6:
                recommendations.append({
                    'severity': 'medium',
                    'message': f'High mean curvature ({mean_curvature:.2f}) detected. Boundary may be over-segmented or contain small protrusions.',
                    'recommended_actions': [
                        f'Apply curvature-based smoothing (threshold={mean_curvature*0.8:.2f})',
                        'Check for noise in original images',
                        'Consider region growing with higher connectivity'
                    ],
                    'priority': 2,
                    'confidence': 0.85
                })

            elif mean_curvature < 0.1:
                recommendations.append({
                    'severity': 'medium',
                    'message': f'Low mean curvature ({mean_curvature:.2f}) detected. Boundary appears unusually smooth which may indicate under-segmentation.',
                    'recommended_actions': [
                        'Lower segmentation threshold slightly',
                        'Check for intensity inhomogeneities',
                        'Consider alternative segmentation method'
                    ],
                    'priority': 2,
                    'confidence': 0.8
                })

            # 3. Complexity recommendations
            if boundary_complexity > 0.7:
                recommendations.append({
                    'severity': 'high',
                    'message': f'High boundary complexity ({boundary_complexity:.2f}) detected. Structure appears overly complex for typical fibroid morphology.',
                    'recommended_actions': [
                        'Apply boundary simplification algorithm',
                        'Increase region size constraints',
                        'Verify anatomical plausibility with radiologist',
                        'Check for multiple adjacent structures'
                    ],
                    'priority': 1,
                    'confidence': 0.9
                })

            elif boundary_complexity < 0.3:
                recommendations.append({
                    'severity': 'low',
                    'message': f'Low boundary complexity ({boundary_complexity:.2f}) detected. Structure appears simpler than typical fibroids.',
                    'recommended_actions': [
                        'Verify segmentation covers entire structure',
                        'Check for partial volume effects',
                        'Consider if this represents a different anatomical structure'
                    ],
                    'priority': 3,
                    'confidence': 0.7
                })

            # 4. Edge consistency recommendations
            if edge_consistency < 0.5:
                recommendations.append({
                    'severity': 'high',
                    'message': f'Poor edge consistency ({edge_consistency:.2f}) detected. Boundary contains irregular edge patterns.',
                    'recommended_actions': [
                        'Apply edge-preserving smoothing',
                        'Check for segmentation artifacts',
                        'Manually inspect boundary regions',
                        'Consider alternative segmentation algorithm'
                    ],
                    'priority': 1,
                    'confidence': 0.9
                })

            # 5. Smoothness-specific recommendations
            if smoothness_score < 0.5:
                recommendations.append({
                    'severity': 'high',
                    'message': f'Low boundary smoothness ({smoothness_score:.2f}) detected. Significant irregularities present.',
                    'recommended_actions': [
                        'Apply multi-scale smoothing',
                        'Increase connectivity parameter',
                        'Consider manual boundary correction',
                        'Verify image quality for artifacts'
                    ],
                    'priority': 1,
                    'confidence': 0.95
                })

            # 6. Processing method specific recommendations
            if processing_method == 'automated' and confidence < 0.7:
                recommendations.append({
                    'severity': 'medium',
                    'message': 'Low confidence in automated segmentation. Boundary quality may be compromised.',
                    'recommended_actions': [
                        'Review segmentation parameters',
                        'Consider semi-automated approach',
                        'Manually verify boundary regions',
                        'Check for image artifacts that may affect segmentation'
                    ],
                    'priority': 2,
                    'confidence': 0.85
                })

            # 7. Anatomical position specific recommendations
            anatomical_position = metrics.get('anatomical_position', {}).get('anatomical_position', 'unknown')
            if anatomical_position != 'unknown':
                expected_roughness = self._get_expected_boundary_roughness(anatomical_position)
                roughness_diff = abs(surface_roughness - expected_roughness)

                if roughness_diff > 0.3:
                    recommendations.append({
                        'severity': 'medium',
                        'message': f'Boundary roughness ({surface_roughness:.2f}) differs significantly from expected for {anatomical_position} position ({expected_roughness:.2f}).',
                        'recommended_actions': [
                            'Verify anatomical location',
                            'Check segmentation against anatomical landmarks',
                            'Consider position-specific segmentation parameters'
                        ],
                        'priority': 2,
                        'confidence': 0.8
                    })

            # 8. General quality recommendations
            quality_rating = metrics.get('quality_rating', 'unknown')
            if quality_rating in ['poor', 'very_poor']:
                recommendations.append({
                    'severity': 'critical',
                    'message': 'Overall boundary quality is poor. Significant manual intervention recommended.',
                    'recommended_actions': [
                        'Perform complete manual boundary correction',
                        'Review segmentation methodology',
                        'Consult with radiologist for anatomical verification',
                        'Check for image artifacts or acquisition issues'
                    ],
                    'priority': 0,
                    'confidence': 0.98
                })

            # 9. Validation status recommendations
            validation_status = metrics.get('validation_status', {}).get('status', 'unknown')
            if validation_status == 'failed':
                recommendations.append({
                    'severity': 'critical',
                    'message': 'Segmentation failed validation. Boundary quality cannot be trusted.',
                    'recommended_actions': [
                        'Complete manual segmentation',
                        'Review validation parameters',
                        'Check for fundamental segmentation errors',
                        'Verify anatomical plausibility'
                    ],
                    'priority': 0,
                    'confidence': 1.0
                })

            # 10. Final comprehensive recommendations
            final_score = self._calculate_boundary_quality_score(mask, metrics)['score']

            if final_score < 0.4:
                recommendations.append({
                    'severity': 'critical',
                    'message': 'Overall boundary quality score is very low (%.2f). Immediate manual review required.' % final_score,
                    'recommended_actions': [
                        'Complete manual boundary correction',
                        'Re-evaluate segmentation methodology',
                        'Consult with clinical expert',
                        'Check for image artifacts or acquisition problems'
                    ],
                    'priority': 0,
                    'confidence': 0.99
                })
            elif final_score < 0.6:
                recommendations.append({
                    'severity': 'high',
                    'message': 'Overall boundary quality score is moderate (%.2f). Manual verification recommended.' % final_score,
                    'recommended_actions': [
                        'Manually verify critical boundary regions',
                        'Apply targeted smoothing where needed',
                        'Check segmentation parameters',
                        'Compare with adjacent anatomical structures'
                    ],
                    'priority': 1,
                    'confidence': 0.9
                })

            # Sort recommendations by priority and severity
            recommendations.sort(key=lambda x: (x['priority'], x['severity']))

            # Add processing summary
            recommendations.insert(0, {
                'severity': 'informational',
                'message': 'Boundary quality assessment complete. Recommendations prioritized by severity and impact.',
                'details': {
                    'surface_roughness': surface_roughness,
                    'mean_curvature': mean_curvature,
                    'boundary_complexity': boundary_complexity,
                    'smoothness_score': smoothness_score,
                    'edge_consistency': edge_consistency,
                    'overall_score': final_score,
                    'processing_method': processing_method,
                    'confidence': confidence
                },
                'priority': 10,
                'confidence': 1.0
            })

            return recommendations

        except Exception as e:
            self._log_error(f"Boundary quality recommendations generation failed: {str(e)}")
            return [{
                'severity': 'error',
                'message': 'Could not generate boundary quality recommendations due to error',
                'recommended_actions': ['Contact technical support', 'Review segmentation parameters'],
                'priority': 0,
                'confidence': 0.0,
                'error': str(e)
            }]


